#!/bin/sh

counter=${MOCK_CODEX_COUNTER:?MOCK_CODEX_COUNTER is required}
last_message=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --output-last-message|-o)
      last_message="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

count=0
if [ -f "$counter" ]; then
  count=$(cat "$counter")
fi
printf '%s' $((count + 1)) > "$counter"

if [ "$count" -eq 0 ]; then
  sleep 5 &
  sleeper=$!
  trap 'kill "$sleeper" 2>/dev/null; wait "$sleeper" 2>/dev/null; exit 143' TERM
  wait "$sleeper"
  exit 0
fi

printf '%s' '{"summary":"startup guard mock","findings":[],"recommended_actions":[],"risks":[],"verification":[],"confidence":"high"}' > "$last_message"
printf '%s\n' '{"type":"thread.started","thread_id":"th_startup_guard"}'
printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":0,"cached_input_tokens":0,"output_tokens":0,"reasoning_output_tokens":0}}'
