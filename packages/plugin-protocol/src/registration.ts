import { siteRegistrationSchema } from "@sitepilot/contracts";

/**
 * Runtime validation for site registration payloads (plugin → app handshake).
 */
export function parseSiteRegistration(data: unknown) {
  return siteRegistrationSchema.safeParse(data);
}
