import { timingSafeEqual } from "node:crypto";
import { eveChannel } from "eve/channels/eve";
import { type AuthFn, extractBearerToken } from "eve/channels/auth";

// Monolith contract: the eve channel admits exactly one caller, the control
// plane, which presents the bearer in MONOLITH_CONTROL_KEY. There is no
// localDev() fallback, so a request without the bearer is refused even on
// loopback. Monolith checks this after the first task is accepted.
const monolithControl: AuthFn<Request> = (request) => {
  const expected = process.env.MONOLITH_CONTROL_KEY ?? "";
  const presented = extractBearerToken(request.headers.get("authorization")) ?? "";
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (expected.length < 32 || a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return {
    attributes: {},
    authenticator: "monolith-control",
    principalId: "monolith-control-plane",
    principalType: "service",
  };
};

export default eveChannel({ auth: [monolithControl] });
