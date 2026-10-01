import {
	ActivityType,
	type Db,
	EnrichmentStatus,
	type Prisma,
} from "@crm/db";
import { lockIdempotencyKey } from "@crm/db/idempotency";
import {
	Injectable,
	Logger,
	ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { EnvironmentVariables } from "../config/env.validation";
import { InjectDatabase } from "../database/database.constants";
import {
	type WhatsAppContact,
	type WhatsAppMessage,
	type WhatsAppValue,
	whatsAppWebhook,
} from "./whatsapp.schemas";

type Direction = "INBOUND" | "OUTBOUND";

type WhatsAppIdentity = {
	phone: string | null;
	userId: string | null;
	parentUserId: string | null;
	username: string | null;
	name: string | null;
};

@Injectable()
export class WhatsAppService {
	private readonly logger = new Logger(WhatsAppService.name);
	private readonly wabaId: string | undefined;
	private readonly phoneNumberId: string | undefined;
	private readonly testAllowlist: ReadonlySet<string>;

	constructor(
		@InjectDatabase() private readonly db: Db,
		config: ConfigService<EnvironmentVariables, true>,
	) {
		this.wabaId = config.get("WHATSAPP_WABA_ID", { infer: true });
		this.phoneNumberId = config.get("WHATSAPP_PHONE_NUMBER_ID", { infer: true });
		this.testAllowlist = parseAllowlist(
			config.get("WHATSAPP_TEST_ALLOWLIST", { infer: true }),
		);
	}

	async receive(input: unknown): Promise<void> {
		if (isDualhookPing(input)) {
			this.logger.log({ message: "Dualhook test ping received" });
			return;
		}

		const parsed = whatsAppWebhook.safeParse(input);
		if (!parsed.success) {
			this.logger.warn({ message: "Ignored unrecognized WhatsApp webhook" });
			return;
		}

		for (const entry of parsed.data.entry) {
			if (this.wabaId && entry.id !== this.wabaId) {
				this.logger.warn({
					message: "Ignored WhatsApp webhook for unexpected WABA",
				});
				continue;
			}

			for (const change of entry.changes) {
				if (change.field !== "messages" && change.field !== "smb_message_echoes") {
					continue;
				}

				const incomingPhoneNumberId = change.value.metadata?.phone_number_id;
				if (
					this.phoneNumberId &&
					incomingPhoneNumberId &&
					incomingPhoneNumberId !== this.phoneNumberId
				) {
					this.logger.warn({
						message: "Ignored WhatsApp webhook for unexpected phone number",
					});
					continue;
				}

				if (change.field === "messages") {
					for (const message of change.value.messages ?? []) {
						await this.fileMessage(change.value, message, "INBOUND");
					}
				}

				if (change.field === "smb_message_echoes") {
					for (const message of change.value.message_echoes ?? []) {
						await this.fileMessage(change.value, message, "OUTBOUND");
					}
				}
			}
		}
	}

	private async fileMessage(
		value: WhatsAppValue,
		message: WhatsAppMessage,
		direction: Direction,
	): Promise<void> {
		const identity =
			direction === "INBOUND"
				? inboundIdentity(value, message)
				: outboundIdentity(value, message);

		if (!identity.phone && !identity.userId) {
			this.logger.warn({
				message: "Ignored WhatsApp message with no usable customer identity",
				wamid: message.id,
			});
			return;
		}

		if (!this.isAllowedForMvp(identity)) {
			this.logger.log({
				message: "Ignored WhatsApp message outside MVP test allowlist",
			});
			return;
		}

		const author = await this.db.user.findFirst({
			orderBy: { createdAt: "asc" },
			select: { id: true },
		});
		if (!author) {
			throw new ServiceUnavailableException(
				"Sign in to the CRM once before enabling WhatsApp ingestion.",
			);
		}

		await this.db.$transaction(async (tx) => {
			await lockIdempotencyKey(tx, `whatsapp-message:${message.id}`);

			const alreadyFiled = await tx.activity.findFirst({
				where: {
					meta: {
						path: ["whatsappMessageId"],
						equals: message.id,
					},
				},
				select: { id: true },
			});
			if (alreadyFiled) return;

			const contact = await this.findOrCreateContact(tx, identity);
			const occurredAt = parseTimestamp(message.timestamp);

			await tx.activity.create({
				data: {
					type: ActivityType.NOTE,
					subject:
						direction === "INBOUND"
							? "WhatsApp · recebida"
							: "WhatsApp · enviada",
					body: messageBody(message),
					occurredAt,
					contactId: contact.id,
					createdById: author.id,
					meta: {
						channel: "whatsapp",
						whatsappMessageId: message.id,
						direction,
						messageType: message.type ?? "unknown",
					},
				},
			});

			await tx.contact.updateMany({
				where: {
					id: contact.id,
					OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: occurredAt } }],
				},
				data: { lastActivityAt: occurredAt },
			});
		});
	}

	private isAllowedForMvp(identity: WhatsAppIdentity): boolean {
		if (this.testAllowlist.size === 0) return true;

		const candidates = [
			identity.userId,
			identity.phone,
			identity.phone?.replace(/\D/g, ""),
		].filter((value): value is string => Boolean(value));

		return candidates.some((value) => this.testAllowlist.has(value));
	}

	private async findOrCreateContact(
		tx: Prisma.TransactionClient,
		identity: WhatsAppIdentity,
	): Promise<{ id: string }> {
		const identityKey = identity.userId ?? identity.phone;
		if (!identityKey) throw new Error("WhatsApp identity unexpectedly empty");
		await lockIdempotencyKey(tx, `whatsapp-contact:${identityKey}`);

		const where = contactIdentityFilter(identity);

		let contact = await tx.contact.findFirst({
			where: { ...where, archivedAt: null },
			select: {
				id: true,
				phone: true,
				whatsappUserId: true,
				whatsappParentUserId: true,
				whatsappUsername: true,
			},
		});

		if (!contact) {
			contact = await tx.contact.findFirst({
				where,
				select: {
					id: true,
					phone: true,
					whatsappUserId: true,
					whatsappParentUserId: true,
					whatsappUsername: true,
				},
			});
			if (contact) {
				await tx.contact.update({
					where: { id: contact.id },
					data: { archivedAt: null },
				});
			}
		}

		if (!contact) {
			const name = splitName(
				identity.name ??
					identity.username ??
					(identity.phone
						? `WhatsApp ${identity.phone.slice(-4)}`
						: "WhatsApp"),
			);

			return tx.contact.create({
				data: {
					firstName: name.firstName,
					lastName: name.lastName ?? null,
					phone: identity.phone,
					whatsappUserId: identity.userId,
					whatsappParentUserId: identity.parentUserId,
					whatsappUsername: identity.username,
					enrichmentStatus: EnrichmentStatus.SKIPPED,
				},
				select: { id: true },
			});
		}

		await tx.contact.update({
			where: { id: contact.id },
			data: {
				...(identity.phone && !contact.phone ? { phone: identity.phone } : {}),
				...(identity.userId && !contact.whatsappUserId
					? { whatsappUserId: identity.userId }
					: {}),
				...(identity.parentUserId && !contact.whatsappParentUserId
					? { whatsappParentUserId: identity.parentUserId }
					: {}),
				...(identity.username &&
				identity.username !== contact.whatsappUsername
					? { whatsappUsername: identity.username }
					: {}),
			},
		});

		return { id: contact.id };
	}
}

function contactIdentityFilter(
	identity: WhatsAppIdentity,
): Prisma.ContactWhereInput {
	const or: Prisma.ContactWhereInput[] = [];

	if (identity.userId) or.push({ whatsappUserId: identity.userId });
	if (identity.phone) or.push({ phone: identity.phone });

	return or.length === 1 ? or[0]! : { OR: or };
}

function inboundIdentity(
	value: WhatsAppValue,
	message: WhatsAppMessage,
): WhatsAppIdentity {
	const fromUserId =
		message.from_user_id ?? stringField(message, "user_id") ?? null;
	const matched = matchContact(value.contacts ?? [], message.from, fromUserId);

	return {
		phone: normalizePhone(message.from ?? matched?.wa_id),
		userId: fromUserId ?? matched?.user_id ?? null,
		parentUserId: matched?.parent_user_id ?? null,
		username: matched?.profile?.username ?? null,
		name: matched?.profile?.name ?? null,
	};
}

function outboundIdentity(
	value: WhatsAppValue,
	message: WhatsAppMessage,
): WhatsAppIdentity {
	const userId =
		stringField(message, "to_user_id") ??
		stringField(message, "recipient_user_id") ??
		stringField(message, "user_id") ??
		null;
	const matched = matchContact(value.contacts ?? [], message.to, userId);

	return {
		phone: normalizePhone(message.to ?? matched?.wa_id),
		userId: userId ?? matched?.user_id ?? null,
		parentUserId: matched?.parent_user_id ?? null,
		username: matched?.profile?.username ?? null,
		name: matched?.profile?.name ?? null,
	};
}

function matchContact(
	contacts: WhatsAppContact[],
	phone?: string,
	userId?: string | null,
): WhatsAppContact | undefined {
	const digits = phone?.replace(/\D/g, "");

	return (
		contacts.find((contact) => Boolean(userId && contact.user_id === userId)) ??
		contacts.find(
			(contact) =>
				Boolean(digits) &&
				contact.wa_id?.replace(/\D/g, "") === digits,
		) ??
		contacts[0]
	);
}

function normalizePhone(value?: string): string | null {
	if (!value) return null;
	const digits = value.replace(/\D/g, "");
	if (digits.length < 8 || digits.length > 15) return null;
	return `+${digits}`;
}

function splitName(name: string): { firstName: string; lastName?: string } {
	const clean = name.trim().replace(/\s+/g, " ");
	const [firstName = "WhatsApp", ...rest] = clean.split(" ");
	return {
		firstName,
		...(rest.length > 0 ? { lastName: rest.join(" ") } : {}),
	};
}

function parseTimestamp(timestamp?: string): Date {
	if (!timestamp) return new Date();
	const seconds = Number(timestamp);
	if (!Number.isFinite(seconds)) return new Date();

	const date = new Date(seconds * 1000);
	return Number.isNaN(date.getTime()) ? new Date() : date;
}

function stringField(
	message: WhatsAppMessage,
	key: string,
): string | undefined {
	const value = message[key];
	return typeof value === "string" ? value : undefined;
}

function messageBody(message: WhatsAppMessage): string {
	if (message.text?.body) return message.text.body;
	if (message.button?.text) return `[botão] ${message.button.text}`;
	if (message.interactive?.button_reply?.title) {
		return `[resposta de botão] ${message.interactive.button_reply.title}`;
	}
	if (message.interactive?.list_reply?.title) {
		return `[resposta de lista] ${message.interactive.list_reply.title}`;
	}

	const caption =
		message.image?.caption ??
		message.video?.caption ??
		message.document?.caption;

	if (caption) return `[${message.type ?? "mídia"}] ${caption}`;
	return `[${message.type ?? "mensagem"}]`;
}

function isDualhookPing(input: unknown): boolean {
	if (!input || typeof input !== "object") return false;
	const record = input as Record<string, unknown>;
	return record.event === "dualhook.test_ping";
}

function parseAllowlist(value?: string): ReadonlySet<string> {
	if (!value?.trim()) return new Set();

	const entries = value
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean)
		.flatMap((entry) => {
			const digits = entry.replace(/\D/g, "");
			return digits.length >= 8 ? [entry, digits, `+${digits}`] : [entry];
		});

	return new Set(entries);
}
