#!/bin/bash
# Enumerate the Checkbook NYC API's real parameter/column spec by sending one
# deliberately-invalid name per domain and capturing the error's "Valid values"
# list.
#
# COMPLIANCE with the limits the Comptroller's office gave us (2026-07-28):
#
#   * 1 request per second      -> PACE below, default 1.5s, applied after every
#                                  call. 31 probes ~= 50s total.
#   * 20,000 records per call   -> every probe asks for max_records=1. These are
#                                  error-path probes; no result set is wanted.
#   * no redirect following     -> curl does not follow redirects without -L.
#                                  Do NOT add -L: a redirect chain is followed
#                                  inside one curl invocation where PACE cannot
#                                  reach it, and one logical call was measured
#                                  fanning out to ~40 requests (issue #23).
#   * identify ourselves        -> UA below. An anonymous curl is exactly the
#                                  shape a WAF blocks, and the office may match
#                                  on this string in their edge logs.
#
# ABORTS ON THE FIRST NON-200. This is the important one. Exceeding the rate
# limit does not throttle: the Imperva edge puts the client into a blocked state
# that persists past the burst and returns 403 to every client on that IP, a
# browser included. Continuing to probe while blocked deepens the hole, which is
# exactly how 2026-07-28 was spent. If a probe fails, STOP and wait it out.
#
# NOT SAFE TO RUN CONCURRENTLY with the MCP server or another copy of this
# script: pacing here and in the MCP client are both per-process, so two runners
# on one network can exceed 1 req/sec no matter how well either behaves
# (issue #28). Run this alone.
set -euo pipefail

OUT="${1:-$(dirname "$0")/../probe-results.txt}"
PACE="${CHECKBOOK_PROBE_PACE:-1.5}"
UA="betanyc-checkbook-mcp-probe/1.0 (github.com/BetaNYC/nyc-checkbook-mcp)"
API="https://www.checkbooknyc.com/api"

: > "$OUT"
probe_count=0

probe () { # $1=label  $2=full request xml
  printf '\n===== %s =====\n' "$1" >> "$OUT"

  local response status body
  # -w appends the status on its own final line; no -L, deliberately.
  response=$(curl -s --max-time 60 -X POST "$API" \
    -H "Content-Type: application/xml" \
    -H "User-Agent: $UA" \
    --data-binary "$2" \
    -w $'\n%{http_code}')
  status="${response##*$'\n'}"
  body="${response%$'\n'*}"

  if [ "$status" != "200" ]; then
    {
      printf 'ABORTED: HTTP %s after %d successful probe(s).\n' "$status" "$probe_count"
      printf 'Probing stopped deliberately. See the header of %s.\n' "$0"
    } >> "$OUT"
    echo "ABORT: HTTP $status on '$1' (after $probe_count OK)." >&2
    if [ "$status" = "403" ]; then
      echo "A 403 here usually means a rate-limit block, not a permissions problem." >&2
      echo "Do NOT re-run to check. Every extra request extends the block." >&2
      echo "Wait, then retry a SINGLE request before running the full sweep." >&2
    fi
    exit 1
  fi

  printf '%s' "$body" \
    | tr -d '\n' \
    | sed -e 's/.*<description>//' -e 's/<\/description>.*//' >> "$OUT"
  printf '\n' >> "$OUT"
  probe_count=$((probe_count + 1))
  sleep "$PACE"
}

crit () { # $1=label $2=type_of_data $3=extra criteria xml
  probe "$1 :: CRITERIA" "<request><type_of_data>$2</type_of_data><records_from>1</records_from><max_records>1</max_records><search_criteria>$3<criteria><name>zzz_invalid</name><type>value</type><value>x</value></criteria></search_criteria></request>"
}

cols () { # $1=label $2=type_of_data $3=extra criteria xml
  probe "$1 :: COLUMNS" "<request><type_of_data>$2</type_of_data><records_from>1</records_from><max_records>1</max_records><search_criteria>$3</search_criteria><response_columns><column>zzz_invalid</column></response_columns></request>"
}

C_REG_EXP='<criteria><name>status</name><type>value</type><value>registered</value></criteria><criteria><name>category</name><type>value</type><value>expense</value></criteria>'
C_REG_REV='<criteria><name>status</name><type>value</type><value>registered</value></criteria><criteria><name>category</name><type>value</type><value>revenue</value></criteria>'
C_PEND='<criteria><name>status</name><type>value</type><value>pending</value></criteria><criteria><name>category</name><type>value</type><value>expense</value></criteria>'
FY='<criteria><name>fiscal_year</name><type>value</type><value>2025</value></criteria>'
BUDGET_Y='<criteria><name>year</name><type>value</type><value>2025</value></criteria>'
CAL_Y='<criteria><name>calendar_year</name><type>value</type><value>2025</value></criteria>'
ISSUE_D='<criteria><name>issue_date</name><type>range</type><start>2025-01-01</start><end>2025-01-31</end></criteria>'
NYCHA_V='<criteria><name>vendor_name</name><type>value</type><value>zzz</value></criteria>'

crit "Contracts registered/expense" Contracts "$C_REG_EXP"
cols "Contracts registered/expense" Contracts "$C_REG_EXP"
crit "Contracts registered/revenue" Contracts "$C_REG_REV"
cols "Contracts registered/revenue" Contracts "$C_REG_REV"
crit "Contracts pending/expense"    Contracts "$C_PEND"
cols "Contracts pending/expense"    Contracts "$C_PEND"

crit "Spending"  Spending "$FY"
cols "Spending"  Spending "$FY"
crit "Budget"    Budget   "$FY"
cols "Budget"    Budget   "$FY"
crit "Revenue"   Revenue  "$FY"
cols "Revenue"   Revenue  "$FY"
crit "Payroll"   Payroll  "$FY"
cols "Payroll"   Payroll  "$FY"

crit "Contracts_OGE" Contracts_OGE "$C_REG_EXP"
cols "Contracts_OGE" Contracts_OGE "$C_REG_EXP"
crit "Spending_OGE"  Spending_OGE  "$FY"
cols "Spending_OGE"  Spending_OGE  "$FY"

crit "Contracts_NYCHA" Contracts_NYCHA "$FY"
cols "Contracts_NYCHA" Contracts_NYCHA "$FY"
crit "Spending_NYCHA"  Spending_NYCHA  "$FY"
cols "Spending_NYCHA"  Spending_NYCHA  "$FY"
crit "Payroll_NYCHA"   Payroll_NYCHA   "$FY"
cols "Payroll_NYCHA"   Payroll_NYCHA   "$FY"

# Call-shape variants. The resolved domain, and so its column vocabulary, depends
# on the criteria sent: with vs without fiscal_year, and the criterion a tool
# actually uses. These match shapes the tools send. scripts/check-default-columns.mjs
# checks every DEFAULT_COLUMNS list against every variant here (issue #40).
cols "Contracts registered/expense FY" Contracts       "$C_REG_EXP$FY"
cols "Contracts pending/expense FY"    Contracts       "$C_PEND$FY"
cols "Contracts_OGE FY"                Contracts_OGE   "$C_REG_EXP$FY"
cols "Contracts_NYCHA no FY"           Contracts_NYCHA "$NYCHA_V"
cols "Spending issue_date"             Spending        "$ISSUE_D"
cols "Budget year"                     Budget          "$BUDGET_Y"
cols "Payroll calendar_year"           Payroll         "$CAL_Y"

printf 'DONE (%d probes)\n' "$probe_count" >> "$OUT"
