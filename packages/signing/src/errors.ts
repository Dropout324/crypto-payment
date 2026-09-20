export class SigningNotConfiguredError extends Error {
  constructor(message = 'no signing backend is configured') {
    super(message);
    this.name = 'SigningNotConfiguredError';
  }
}

export class DestinationNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DestinationNotAllowedError';
  }
}

export class AmountCeilingExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmountCeilingExceededError';
  }
}

export class SelfApprovalError extends Error {
  constructor(message = 'the requester cannot also approve their own signing request') {
    super(message);
    this.name = 'SelfApprovalError';
  }
}

export class UnknownSigningRequestError extends Error {
  constructor(requestId: string) {
    super(`no pending signing request with id ${requestId}`);
    this.name = 'UnknownSigningRequestError';
  }
}

export class SigningRequestAlreadyDecidedError extends Error {
  constructor(requestId: string, status: string) {
    super(`signing request ${requestId} is already ${status.toLowerCase()}, not pending approval`);
    this.name = 'SigningRequestAlreadyDecidedError';
  }
}

export class KeyNotFoundError extends Error {
  constructor(keyId: string) {
    super(`no key with id ${keyId} exists in this key store`);
    this.name = 'KeyNotFoundError';
  }
}

export class NoKeyMappedError extends Error {
  constructor(fromAddress: string, network: string) {
    super(`no signing key is mapped to ${fromAddress} on ${network}`);
    this.name = 'NoKeyMappedError';
  }
}
