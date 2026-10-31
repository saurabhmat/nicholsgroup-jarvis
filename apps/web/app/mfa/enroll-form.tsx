"use client";
// Authenticator enrolment (T-019): "Set up" creates the factor (POST); the QR code and key stay on screen while the
// user enters codes, so a typo does not invalidate what they scanned.
import { useActionState } from "react";
import { Alert, AlertDescription, Button, Input, Label } from "@nichols/ui";
import { beginEnrollment, verifyEnrollment, type EnrollmentState, type VerifyState } from "./actions";

const ERRORS = {
  code: "That code is wrong. Use the current code from your authenticator app.",
  unavailable: "Setup is unavailable right now. Try again in a minute.",
} as const;

export function EnrollForm({ next }: { next: string }) {
  const [enrollment, start, starting] = useActionState<EnrollmentState>(beginEnrollment, null);
  const [verify, submit, verifying] = useActionState<VerifyState, FormData>(verifyEnrollment, null);

  if (enrollment === null || "error" in enrollment) {
    return (
      <form action={start} className="flex flex-col gap-4">
        {enrollment && (
          <Alert variant="alert">
            <AlertDescription>{ERRORS.unavailable}</AlertDescription>
          </Alert>
        )}
        <Button type="submit" disabled={starting}>
          Set up authenticator
        </Button>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* eslint-disable-next-line @next/next/no-img-element -- inline SVG data URI from Supabase, not an asset */}
      <img
        src={enrollment.qrDataUri}
        alt="QR code for your authenticator app"
        width={192}
        height={192}
        className="mx-auto rounded-control bg-white p-2"
      />
      <div className="flex flex-col gap-1">
        <Label htmlFor="secret">Or enter this key manually</Label>
        <Input id="secret" readOnly value={enrollment.secret} className="font-mono text-sm" data-testid="totp-secret" />
      </div>
      <form action={submit} className="flex flex-col gap-4">
        {verify && (
          <Alert variant="alert">
            <AlertDescription>{ERRORS[verify.error]}</AlertDescription>
          </Alert>
        )}
        <input type="hidden" name="factorId" value={enrollment.factorId} />
        <input type="hidden" name="next" value={next} />
        <div className="flex flex-col gap-2">
          <Label htmlFor="code">Authenticator code</Label>
          <Input
            id="code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            autoFocus
            aria-invalid={verify ? true : undefined}
          />
        </div>
        <Button type="submit" disabled={verifying}>
          Verify
        </Button>
      </form>
    </div>
  );
}
