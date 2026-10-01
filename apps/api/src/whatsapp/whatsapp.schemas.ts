import { z } from "zod";

export const whatsAppContact = z.looseObject({
	wa_id: z.string().optional(),
	user_id: z.string().optional(),
	parent_user_id: z.string().optional(),
	profile: z
		.looseObject({
			name: z.string().optional(),
			username: z.string().optional(),
		})
		.optional(),
});

export const whatsAppMessage = z.looseObject({
	from: z.string().optional(),
	from_user_id: z.string().optional(),
	to: z.string().optional(),
	id: z.string(),
	timestamp: z.string().optional(),
	type: z.string().optional(),
	text: z.looseObject({ body: z.string().optional() }).optional(),
	image: z.looseObject({ caption: z.string().optional() }).optional(),
	video: z.looseObject({ caption: z.string().optional() }).optional(),
	document: z.looseObject({ caption: z.string().optional() }).optional(),
	button: z.looseObject({ text: z.string().optional() }).optional(),
	interactive: z
		.looseObject({
			button_reply: z.looseObject({ title: z.string().optional() }).optional(),
			list_reply: z.looseObject({ title: z.string().optional() }).optional(),
		})
		.optional(),
});

export const whatsAppValue = z.looseObject({
	metadata: z
		.looseObject({
			phone_number_id: z.string().optional(),
			display_phone_number: z.string().optional(),
		})
		.optional(),
	contacts: z.array(whatsAppContact).optional(),
	messages: z.array(whatsAppMessage).optional(),
	message_echoes: z.array(whatsAppMessage).optional(),
});

export const whatsAppChange = z.looseObject({
	field: z.string(),
	value: whatsAppValue,
});

export const whatsAppEntry = z.looseObject({
	id: z.string(),
	changes: z.array(whatsAppChange),
});

export const whatsAppWebhook = z.looseObject({
	object: z.literal("whatsapp_business_account"),
	entry: z.array(whatsAppEntry),
});

export type WhatsAppContact = z.infer<typeof whatsAppContact>;
export type WhatsAppMessage = z.infer<typeof whatsAppMessage>;
export type WhatsAppValue = z.infer<typeof whatsAppValue>;
