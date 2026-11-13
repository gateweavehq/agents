import { env } from "cloudflare:workers";
import { demoEnabled } from "../demo/mode";
import { limitRecipients } from "../rate-limit";
import { createMailer } from "./mailer";

/**
 * Undefined when email is not configured, and on the public demo, whose visitors have made-up
 * addresses and could otherwise send mail from it to anyone they invite.
 */
export const mailer = demoEnabled()
	? undefined
	: limitRecipients(createMailer(env.EMAIL, env.EMAIL_FROM || undefined));
