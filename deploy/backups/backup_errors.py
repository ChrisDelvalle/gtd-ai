"""Shared failure categories for both supported recovery payloads."""


class Skipped(RuntimeError):
    pass


class VerificationFailure(RuntimeError):
    """Verification failed; the cause may be the archive or its environment."""
    pass


class Corruption(VerificationFailure):
    pass
