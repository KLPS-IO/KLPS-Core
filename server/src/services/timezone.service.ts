const DEFAULT_TIMEZONE =
  "UTC";

function isValidTimezone(
  timezone: string
): boolean {

  try {

    new Intl.DateTimeFormat(
      "en-GB",
      { timeZone: timezone }
    );

    return true;

  } catch {

    return false;

  }

}

function firstString(
  value: unknown
): string | null {

  if (typeof value === "string") {

    const trimmed =
      value.trim();

    return trimmed.length > 0
      ? trimmed
      : null;

  }

  if (
    Array.isArray(value) &&
    typeof value[0] === "string"
  ) {

    const trimmed =
      value[0].trim();

    return trimmed.length > 0
      ? trimmed
      : null;

  }

  return null;

}

export function resolveTimezone({
  bodyTimezone,
  queryTimezone,
  headerTimezone
}: {
  bodyTimezone?: unknown;
  queryTimezone?: unknown;
  headerTimezone?: unknown;
}): string {

  const candidates = [
    firstString(bodyTimezone),
    firstString(queryTimezone),
    firstString(headerTimezone)
  ];

  for (const timezone of candidates) {

    if (
      timezone &&
      isValidTimezone(timezone)
    ) {
      return timezone;
    }

  }

  return DEFAULT_TIMEZONE;

}

export { DEFAULT_TIMEZONE };
