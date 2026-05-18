import { Resend } from "resend";

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const getResendClient = () => {
  const apiKey =
    process.env.RESEND_API_KEY;

  if (!apiKey) {
    return null;
  }

  return new Resend(apiKey);
};

export const sendDataRoomOtpEmail = async ({
  email,
  otpCode
}: {
  email: string;
  otpCode: string;
}) => {
  const resend = getResendClient();
  const from =
    process.env.EMAIL_FROM;

  if (!resend || !from) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "Resend email delivery is not configured"
      );
    }

    console.log(
      `KLPS data room OTP for ${email}: ${otpCode}`
    );
    return;
  }

  const safeCode =
    escapeHtml(otpCode);

  await resend.emails.send({
    from,
    to: email,
    subject: "Your KLPS Investor Access Code",
    text:
      `Your KLPS Investor Data Room secure login code is ${otpCode}. ` +
      "This code expires shortly.",
    html: `
      <div style="font-family: Arial, sans-serif; color: #17111d; line-height: 1.5;">
        <p>Your KLPS Investor Data Room secure login code is:</p>
        <p style="font-size: 28px; font-weight: 700; letter-spacing: 4px;">
          ${safeCode}
        </p>
        <p>This code expires shortly. If you did not request it, you can ignore this email.</p>
      </div>
    `
  });
};
