#!/usr/bin/env python3
"""
Preparation of the N5Deal lead CSV for the platform bulk import.

Input : leads/source/batch1_original.csv  (as exported from the previous run)
Output: leads/import/*.csv                (platform-ready files + a working reference)

The original file parses cleanly as CSV (133 rows x 9 fields, correct quoting),
so the rejection is a content problem, not a syntax problem. Defects found and
repaired here:

  1. company empty in 101 of 132 rows  -> filled (extracted employer, else person name)
  2. comments longer than 255 chars in 114 rows (max 454) -> compacted to <= 200
  3. comments contain Cyrillic + em dash (119 rows)        -> ASCII only
  4. resource empty in all 132 rows                        -> left empty, kept in header
  5. Loukas Lagoudis duplicates a lead entered by hand      -> dropped

Every output row has exactly 9 fields, RFC4180 quoting, CRLF line endings.
"""

import csv
import os
import re
import sys

HEADER = ["company", "contact_persons", "type", "source",
          "resource", "email", "phone", "comments", "priority"]

# leads already present in the platform, entered by hand - do not import again
SKIP_CONTACTS = {"loukas lagoudis"}

# Cyrillic labels used inside the comment field of the source file
RE_TRACK = re.compile(r"^\s*\[([^\]]*)\]\s*")
RE_LOCATION = re.compile(r"Локация:\s*([^|]+)")
RE_HOOK = re.compile(r"Зацепка:\s*([^|]+)")
RE_STATUS = re.compile(r"СТАТУС[^:]*:\s*([^|]+)")
RE_MANAGER = re.compile(r"Control manager:\s*([^|]+)")

TRACK_EN = {
    "Active broker / M&A advisor": "Broker/M&A",
    "Active broker / seller": "Broker/seller",
    "Introducer": "Introducer",
    "Service provider": "Service provider",
    "Трек не определён": "Track TBD",
}

# employer patterns inside the LinkedIn headline, most specific first
EMPLOYER_PATTERNS = [
    re.compile(r"\bPartner at ([A-Z][\w&.\-']*(?: [A-Z][\w&.\-']*){0,3})"),
    re.compile(r"\b(?:CEO|CTO|COO|CFO|MD|Managing Director|Director|Head)"
               r" (?:of|at) ([A-Z][\w&.\-']*(?: [A-Z][\w&.\-']*){0,3})"),
    re.compile(r"\bFounder(?: & (?:CEO|MD|Director))? (?:of |at )?"
               r"([A-Z][\w&.\-']*(?: [A-Z][\w&.\-']*){0,2})"),
    re.compile(r"\bat ([A-Z][\w&.\-']*(?: [A-Z][\w&.\-']*){0,2})"),
]

# words that are job-title noise, never a company name
NOT_A_COMPANY = {
    "M&A", "Fintech", "FinTech", "Payments", "Banking", "Licensing", "Advisor",
    "Consultant", "Board", "Group", "Partner", "Partners", "Capital", "The",
    "Independent", "Strategic", "Corporate", "Investment", "Interim", "NED",
    # department names: "Head of Legal" must not become the company "Legal"
    "Legal", "Compliance", "Risk", "Sales", "Operations", "Product", "Finance",
    "Regulatory", "Marketing", "Growth", "Technology", "Engineering", "Business",
}


# The five rows whose headline or status is written in Russian. ASCII stripping
# would reduce them to debris, so they are restated in English by hand.
OVERRIDE_HEADLINE = {
    "Ryan Morgan": "Gave WhatsApp +44 7512 188185 instead of booking Calendly",
    "Julian Liniger": "CEO Relai, Forbes 30u30. Replied only Good to be connected",
    "Peter Cox": "Group thread with Oliver Smith. Mobile +44 7970131888. Travelling",
    "Mariusz Malec": "Helps owners sell their company. Business valuation, sale, fundraising. 25+ yrs",
    "Igor Chukhray": "Corporate and payment routes. EMI onboarding. SEPA/SWIFT. Private banking alternatives",
}

OVERRIDE_STATUS = {
    "Ryan Morgan": "handover to Yuliia sent, asked for Telegram. Jurisdiction and track not qualified",
    "Julian Liniger": "touch 2 sent plus Telegram request. Not qualified yet",
    "Peter Cox": "Egor replied personally 15:33. Call from week of 6 September",
}


def tidy(text):
    """Remove punctuation debris left behind after non-ASCII words are dropped."""
    text = re.sub(r"[;,]\s*(?=[;,])", "", text)
    text = re.sub(r"\|\s*(?=\|)", "", text)
    text = re.sub(r"[\s;,]*\|", " |", text)
    text = re.sub(r"\(\s*\)", "", text)
    text = re.sub(r"\s{2,}", " ", text)
    return text.strip(" |;,.-")


def strip_accents_to_ascii(text):
    """Transliterate the few non-ASCII characters that survive into plain ASCII."""
    table = {
        "—": "-", "–": "-", "‑": "-", "«": '"', "»": '"',
        "“": '"', "”": '"', "‘": "'", "’": "'", "…": "...",
        " ": " ", " ": " ", "ё": "e", "Ё": "E",
    }
    out = []
    for ch in text:
        ch = table.get(ch, ch)
        out.append(ch if ord(ch) < 128 else "")
    return re.sub(r"\s{2,}", " ", "".join(out)).strip(" |-")


def parse_comment(comment):
    """Split the source comment into its structured parts."""
    track = ""
    m = RE_TRACK.match(comment)
    if m:
        track = m.group(1).strip()
    body = RE_TRACK.sub("", comment)
    headline = body.split("| Локация")[0].split("| Control manager")[0].strip(" |")
    location = (RE_LOCATION.search(comment).group(1).strip()
                if RE_LOCATION.search(comment) else "")
    hook = (RE_HOOK.search(comment).group(1).strip()
            if RE_HOOK.search(comment) else "")
    status = (RE_STATUS.search(comment).group(1).strip()
              if RE_STATUS.search(comment) else "")
    manager = (RE_MANAGER.search(comment).group(1).strip()
               if RE_MANAGER.search(comment) else "")
    return {
        "track": track,
        "headline": headline,
        "location": location,
        "hook": hook,
        "status": status,
        "manager": manager,
    }


def derive_company(row, parts):
    """Return (company, how_it_was_derived)."""
    existing = row["company"].strip()
    if existing:
        return existing, "source"

    headline = parts["headline"]
    for pattern in EMPLOYER_PATTERNS:
        m = pattern.search(headline)
        if not m:
            continue
        candidate = m.group(1).strip(" .,&")
        first = candidate.split()[0] if candidate.split() else ""
        if first in NOT_A_COMPANY or len(candidate) < 3:
            continue
        return candidate, "headline"

    # individual advisers with no employer in the headline: the person is the entity
    name = row["contact_persons"].strip()
    name = re.sub(r",\s*(CFA|MSc|MBA|LL\.M\.|PhD|ACA|ACCA)\b.*$", "", name).strip()
    return name, "person"


def build_comment(parts, name="", ascii_only=True, limit=200):
    """Compact, machine-safe comment. Structure first, then as much headline as fits."""
    track = TRACK_EN.get(parts["track"], parts["track"] or "Track TBD")
    owner = "owner: UNASSIGNED" if "НЕ ЗАКРЕПЛ" in parts["manager"] else \
            ("owner: " + parts["manager"] if parts["manager"] else "owner: UNASSIGNED")

    prefix_bits = ["[%s]" % track]
    if parts["location"]:
        prefix_bits.append(parts["location"])
    prefix_bits.append(owner)
    prefix_bits.append("LinkedIn 28.08.2026")
    prefix_bits.append("NOT SENT" if not parts["status"] else "LIVE THREAD")
    prefix = " | ".join(prefix_bits)

    if ascii_only:
        prefix = strip_accents_to_ascii(prefix)

    if parts["status"]:
        tail_source = OVERRIDE_STATUS.get(name) or parts["status"]
    else:
        tail_source = OVERRIDE_HEADLINE.get(name) or parts["headline"]
    tail = tidy(strip_accents_to_ascii(tail_source)) if ascii_only else tail_source

    room = limit - len(prefix) - 3
    if tail and room > 20:
        if len(tail) > room:
            tail = tail[:room].rsplit(" ", 1)[0] + ".."
        comment = prefix + " | " + tail
    else:
        comment = prefix
    return comment[:limit]


def write_csv(path, rows):
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=HEADER, quoting=csv.QUOTE_ALL,
                                lineterminator="\r\n")
        writer.writeheader()
        writer.writerows(rows)
    return path


def main():
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    src = os.path.join(base, "source", "batch1_original.csv")
    out_dir = os.path.join(base, "import")
    os.makedirs(out_dir, exist_ok=True)

    with open(src, newline="", encoding="utf-8") as fh:
        source_rows = list(csv.DictReader(fh))

    import_rows, reference_rows = [], []
    stats = {"source": 0, "headline": 0, "person": 0, "skipped": 0}

    for row in source_rows:
        if row["contact_persons"].strip().lower() in SKIP_CONTACTS:
            stats["skipped"] += 1
            continue

        parts = parse_comment(row["comments"])
        company, how = derive_company(row, parts)
        stats[how] += 1

        comment = build_comment(parts, row["contact_persons"].strip())
        import_rows.append({
            "company": strip_accents_to_ascii(company),
            "contact_persons": strip_accents_to_ascii(row["contact_persons"]),
            "type": row["type"].strip(),
            "source": row["source"].strip(),
            "resource": "",
            "email": row["email"].strip(),
            "phone": row["phone"].strip(),
            "comments": comment,
            "priority": row["priority"].strip(),
        })

        reference_rows.append({
            "company": company,
            "contact_persons": row["contact_persons"],
            "company_source": how,
            "track": parts["track"],
            "location": parts["location"],
            "control_manager": parts["manager"],
            "priority": row["priority"],
            "email": row["email"],
            "phone": row["phone"],
            "headline": parts["headline"],
            "hook_ru": parts["hook"],
            "status": parts["status"],
            "comment_original": row["comments"],
        })

    # 1. the full platform-ready file
    write_csv(os.path.join(out_dir, "n5deal_leads_v2_full.csv"), import_rows)

    # 2. the same data in chunks, so one bad row cannot take the whole batch down
    chunk = 25
    for i in range(0, len(import_rows), chunk):
        n = i // chunk + 1
        write_csv(os.path.join(out_dir, "n5deal_leads_v2_part%02d.csv" % n),
                  import_rows[i:i + chunk])

    # 3. a three-row probe: shortest possible content, to confirm the pipe works
    probe = []
    for row in import_rows[:3]:
        probe.append({**row, "comments": "Import test row. Not sent yet.",
                      "email": "", "phone": ""})
    write_csv(os.path.join(out_dir, "n5deal_leads_v2_probe.csv"), probe)

    # 4. the working reference - full context, NOT for import
    ref_path = os.path.join(out_dir, "n5deal_leads_v2_reference.csv")
    with open(ref_path, "w", newline="", encoding="utf-8-sig") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(reference_rows[0].keys()),
                                quoting=csv.QUOTE_ALL, lineterminator="\r\n")
        writer.writeheader()
        writer.writerows(reference_rows)

    lengths = [len(r["comments"]) for r in import_rows]
    print("source rows      : %d" % len(source_rows))
    print("skipped (dupes)  : %d" % stats["skipped"])
    print("import rows      : %d" % len(import_rows))
    print("company kept     : %d" % stats["source"])
    print("company from job : %d" % stats["headline"])
    print("company = person : %d" % stats["person"])
    print("comment max len  : %d" % max(lengths))
    print("chunks           : %d" % ((len(import_rows) + chunk - 1) // chunk))


if __name__ == "__main__":
    sys.exit(main())
