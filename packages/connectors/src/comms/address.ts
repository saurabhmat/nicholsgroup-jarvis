// The one address-format rule: a local part without specials, "@", a host of letters, digits, dots, hyphens. Shared by the
// comms schemas and Google's header parser (it lives here so the comms layer imports no provider code).
export const MAIL_ADDRESS = /^[^\s@<>(),;:"\\]{1,64}@[A-Za-z0-9.-]{1,253}$/;
export const isMailAddress = (a: string): boolean => MAIL_ADDRESS.test(a);
