import { Activity, CheckCircle2, FileText, Shield } from "./icons.js";
import { compactText, formatDate } from "./state.js";

const React = window.React;
const { useState } = React;
const h = React.createElement;

function sessionTitle(session) {
  if (session.namespace === "loop" && session.goal) return session.goal;
  const latest = Array.isArray(session.reviews) && session.reviews.length ? session.reviews[session.reviews.length - 1] : null;
  return (latest && (latest.prompt || latest.amended_prompt)) || `${session.namespace} session`;
}

function ReviewIcon({ decision }) {
  const props = { size: 16, strokeWidth: 2.1 };
  if (decision === "allow") return h(CheckCircle2, props);
  if (decision === "block") return h(Activity, props);
  return h(FileText, props);
}

function ReviewRow({ review, expanded, onToggle }) {
  const title = review.kind === "stop" ? `Stop review${review.decision ? ` / ${review.decision}` : ""}` : "Prompt review";
  const body = review.review || review.amended_prompt || review.next_prompt || "";
  return h(
    "article",
    { className: `hook-review${expanded ? " selected" : ""}` },
    h(
      "button",
      { type: "button", className: "hook-review-row", onClick: onToggle, "aria-expanded": expanded },
      h("time", null, formatDate(review.at)),
      h("span", { className: "hook-review-kind" }, h(ReviewIcon, { decision: review.decision }), title),
      h("span", { className: "hook-review-summary" }, compactText(body, 140)),
      h("span", { className: "hook-review-meta" }, review.confidence || review.backend || "")
    ),
    expanded
      ? h(
          "div",
          { className: "hook-review-details" },
          review.prompt ? h("p", null, h("strong", null, "Prompt: "), review.prompt) : null,
          review.amended_prompt ? h("p", null, h("strong", null, "Amended: "), review.amended_prompt) : null,
          review.next_prompt ? h("p", null, h("strong", null, "Next: "), review.next_prompt) : null,
          review.review ? h("p", null, h("strong", null, "Review: "), review.review) : null
        )
      : null
  );
}

function SessionCard({ session }) {
  const [expanded, setExpanded] = useState("");
  const reviews = Array.isArray(session.reviews) ? session.reviews.slice().reverse() : [];
  const latest = session.latest_at || session.updated_at || session.activated_at;
  return h(
    "article",
    { className: `hook-session hook-${session.namespace}` },
    h(
      "header",
      { className: "hook-session-heading" },
      h("div", null, h("span", { className: "hook-session-label" }, session.namespace), h("h3", null, sessionTitle(session))),
      h("span", { className: "hook-session-count" }, `${session.review_count || 0} reviews`)
    ),
    session.goal ? h("p", { className: "hook-goal" }, h("strong", null, "Goal: "), session.goal) : null,
    h(
      "div",
      { className: "hook-session-meta" },
      latest ? h("span", null, `Updated ${formatDate(latest)}`) : null,
      Number.isFinite(session.continues) ? h("span", null, `Continues ${session.continues}`) : null,
      session.cwd ? h("span", null, compactText(session.cwd, 80)) : null
    ),
    reviews.length
      ? h(
          "div",
          { className: "hook-review-list" },
          reviews.slice(0, 6).map((review, index) => {
            const key = `${review.at || ""}-${review.kind || ""}-${index}`;
            return h(ReviewRow, {
              key,
              review,
              expanded: expanded === key,
              onToggle: () => setExpanded((current) => (current === key ? "" : key))
            });
          })
        )
      : h("p", { className: "hook-empty" }, "No peer or loop reviews recorded yet.")
  );
}

export function HookSessionsPanel({ sessions }) {
  const visible = Array.isArray(sessions) ? sessions.filter((session) => session && !session.unreadable) : [];
  if (!visible.length) return null;
  return h(
    "section",
    { className: "hook-sessions-panel", "aria-label": "Peer and loop reviews" },
    h(
      "header",
      { className: "journal-heading" },
      h("div", null, h(Shield, { size: 20 }), h("h2", null, "Goals & Reviews")),
      h("span", { className: "live-indicator" }, h(Activity, { size: 14 }), "Fable")
    ),
    h("div", { className: "hook-session-grid" }, visible.slice(0, 6).map((session) => h(SessionCard, { key: `${session.namespace}-${session.id}`, session })))
  );
}
