import type { IncomingMessage } from "node:http";
import {
	Controller,
	ForbiddenException,
	Get,
	HttpCode,
	Logger,
	Param,
	Post,
	Query,
	Req,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import type { EnvironmentVariables } from "../config/env.validation";
import { WhatsAppService } from "./whatsapp.service";

const MAX_WEBHOOK_BODY_BYTES = 4 * 1024 * 1024;

@Controller("webhooks/whatsapp/:pathSecret")
export class WhatsAppController {
	private readonly logger = new Logger(WhatsAppController.name);
	private readonly verifyToken: string | undefined;
	private readonly pathSecret: string | undefined;

	constructor(
		config: ConfigService<EnvironmentVariables, true>,
		private readonly whatsapp: WhatsAppService,
	) {
		this.verifyToken = config.get("WHATSAPP_WEBHOOK_VERIFY_TOKEN", {
			infer: true,
		});
		this.pathSecret = config.get("WHATSAPP_WEBHOOK_PATH_SECRET", {
			infer: true,
		});
	}

	@Get()
	@AllowAnonymous()
	verify(
		@Param("pathSecret") pathSecret: string,
		@Query("hub.mode") mode?: string,
		@Query("hub.verify_token") token?: string,
		@Query("hub.challenge") challenge?: string,
	): string {
		this.requirePathSecret(pathSecret);

		if (
			mode !== "subscribe" ||
			!this.verifyToken ||
			!timingSafeEquals(token ?? "", this.verifyToken)
		) {
			throw new ForbiddenException();
		}

		return challenge ?? "";
	}

	@Post()
	@AllowAnonymous()
	@HttpCode(200)
	async receive(
		@Param("pathSecret") pathSecret: string,
		@Req() request: IncomingMessage,
	): Promise<{ received: true }> {
		this.requirePathSecret(pathSecret);

		const raw = await read(request, MAX_WEBHOOK_BODY_BYTES);
		if (!raw) {
			this.logger.warn({ message: "Ignored empty or oversized WhatsApp webhook" });
			return { received: true };
		}

		let payload: unknown;
		try {
			payload = JSON.parse(raw);
		} catch {
			this.logger.warn({ message: "Ignored invalid WhatsApp webhook JSON" });
			return { received: true };
		}

		await this.whatsapp.receive(payload);
		return { received: true };
	}

	private requirePathSecret(pathSecret: string): void {
		if (!this.pathSecret || !timingSafeEquals(pathSecret, this.pathSecret)) {
			throw new ForbiddenException();
		}
	}
}

async function read(
	request: IncomingMessage,
	limit: number,
): Promise<string | null> {
	const existing = (request as IncomingMessage & { body?: unknown }).body;
	if (existing !== undefined) {
		const text =
			typeof existing === "string" ? existing : JSON.stringify(existing);
		return Buffer.byteLength(text, "utf8") <= limit ? text : null;
	}

	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let settled = false;

		const finish = (value: string | null) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};

		request.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				request.destroy();
				finish(null);
				return;
			}
			chunks.push(chunk);
		});

		request.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
		request.on("error", () => finish(null));
	});
}

function timingSafeEquals(a: string, b: string): boolean {
	if (a.length !== b.length) return false;

	let mismatch = 0;
	for (let index = 0; index < a.length; index += 1) {
		mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
	}

	return mismatch === 0;
}
