const h = window.React.createElement;

function svg(props, children) {
  const size = props && props.size ? props.size : 18;
  const strokeWidth = props && props.strokeWidth ? props.strokeWidth : 2.25;
  const className = props && props.className ? props.className : undefined;
  return h(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      className,
      "aria-hidden": "true"
    },
    children
  );
}

export function Activity(props) {
  return svg(props, [
    h("path", { key: "a", d: "M22 12h-4l-3 8L9 4l-3 8H2" })
  ]);
}

export function AlertTriangle(props) {
  return svg(props, [
    h("path", { key: "a", d: "m21.7 18.9-8.2-14.2a1.7 1.7 0 0 0-3 0L2.3 18.9A1.7 1.7 0 0 0 3.8 21h16.4a1.7 1.7 0 0 0 1.5-2.1Z" }),
    h("path", { key: "b", d: "M12 9v4" }),
    h("path", { key: "c", d: "M12 17h.01" })
  ]);
}

export function BookOpen(props) {
  return svg(props, [
    h("path", { key: "a", d: "M2 6.5A2.5 2.5 0 0 1 4.5 4H11v16H4.5A2.5 2.5 0 0 1 2 17.5Z" }),
    h("path", { key: "b", d: "M22 6.5A2.5 2.5 0 0 0 19.5 4H13v16h6.5a2.5 2.5 0 0 0 2.5-2.5Z" })
  ]);
}

export function CheckCircle2(props) {
  return svg(props, [
    h("circle", { key: "a", cx: "12", cy: "12", r: "10" }),
    h("path", { key: "b", d: "m9 12 2 2 4-5" })
  ]);
}

export function CircleSlash(props) {
  return svg(props, [
    h("circle", { key: "a", cx: "12", cy: "12", r: "10" }),
    h("path", { key: "b", d: "m4.9 4.9 14.2 14.2" })
  ]);
}

export function Clock3(props) {
  return svg(props, [
    h("circle", { key: "a", cx: "12", cy: "12", r: "10" }),
    h("path", { key: "b", d: "M12 6v6l4 2" })
  ]);
}

export function CircleDot(props) {
  return svg(props, [
    h("circle", { key: "a", cx: "12", cy: "12", r: "10" }),
    h("circle", { key: "b", cx: "12", cy: "12", r: "2" })
  ]);
}

export function Code2(props) {
  return svg(props, [
    h("path", { key: "a", d: "m18 16 4-4-4-4" }),
    h("path", { key: "b", d: "m6 8-4 4 4 4" }),
    h("path", { key: "c", d: "m14.5 4-5 16" })
  ]);
}

export function Database(props) {
  return svg(props, [
    h("ellipse", { key: "a", cx: "12", cy: "5", rx: "8", ry: "3" }),
    h("path", { key: "b", d: "M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" }),
    h("path", { key: "c", d: "M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" })
  ]);
}

export function FileText(props) {
  return svg(props, [
    h("path", { key: "a", d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" }),
    h("path", { key: "b", d: "M14 2v6h6" }),
    h("path", { key: "c", d: "M16 13H8" }),
    h("path", { key: "d", d: "M16 17H8" }),
    h("path", { key: "e", d: "M10 9H8" })
  ]);
}

export function FlaskConical(props) {
  return svg(props, [
    h("path", { key: "a", d: "M10 2v7.3L4.3 19A2 2 0 0 0 6 22h12a2 2 0 0 0 1.7-3L14 9.3V2" }),
    h("path", { key: "b", d: "M8 2h8" }),
    h("path", { key: "c", d: "M7 16h10" })
  ]);
}

export function GitBranch(props) {
  return svg(props, [
    h("line", { key: "a", x1: "6", y1: "3", x2: "6", y2: "15" }),
    h("circle", { key: "b", cx: "18", cy: "6", r: "3" }),
    h("circle", { key: "c", cx: "6", cy: "18", r: "3" }),
    h("path", { key: "d", d: "M18 9a9 9 0 0 1-9 9" })
  ]);
}

export function Hourglass(props) {
  return svg(props, [
    h("path", { key: "a", d: "M5 22h14" }),
    h("path", { key: "b", d: "M5 2h14" }),
    h("path", { key: "c", d: "M17 22v-4.2a4 4 0 0 0-1.2-2.8L12 12l-3.8 3A4 4 0 0 0 7 17.8V22" }),
    h("path", { key: "d", d: "M7 2v4.2A4 4 0 0 0 8.2 9L12 12l3.8-3A4 4 0 0 0 17 6.2V2" })
  ]);
}

export function Layers3(props) {
  return svg(props, [
    h("path", { key: "a", d: "m12 2 9 5-9 5-9-5Z" }),
    h("path", { key: "b", d: "m3 12 9 5 9-5" }),
    h("path", { key: "c", d: "m3 17 9 5 9-5" })
  ]);
}

export function ListChecks(props) {
  return svg(props, [
    h("path", { key: "a", d: "m3 7 2 2 4-4" }),
    h("path", { key: "b", d: "m3 17 2 2 4-4" }),
    h("path", { key: "c", d: "M13 6h8" }),
    h("path", { key: "d", d: "M13 12h8" }),
    h("path", { key: "e", d: "M13 18h8" })
  ]);
}

export function Loader2(props) {
  return svg(props, [
    h("path", { key: "a", d: "M21 12a9 9 0 1 1-6.2-8.6" })
  ]);
}

export function Pause(props) {
  return svg(props, [
    h("path", { key: "a", d: "M8 5v14" }),
    h("path", { key: "b", d: "M16 5v14" })
  ]);
}

export function RefreshCcw(props) {
  return svg(props, [
    h("path", { key: "a", d: "M21 12a9 9 0 0 1-15 6.7L3 16" }),
    h("path", { key: "b", d: "M3 16h5v5" }),
    h("path", { key: "c", d: "M3 12a9 9 0 0 1 15-6.7L21 8" }),
    h("path", { key: "d", d: "M21 8h-5V3" })
  ]);
}

export function Search(props) {
  return svg(props, [
    h("circle", { key: "a", cx: "11", cy: "11", r: "8" }),
    h("path", { key: "b", d: "m21 21-4.3-4.3" })
  ]);
}

export function Shield(props) {
  return svg(props, [
    h("path", { key: "a", d: "M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3Z" })
  ]);
}

export function TimerReset(props) {
  return svg(props, [
    h("path", { key: "a", d: "M10 2h4" }),
    h("path", { key: "b", d: "M12 14v-4" }),
    h("path", { key: "c", d: "M4 13a8 8 0 1 0 2.3-5.7" }),
    h("path", { key: "d", d: "M2 7h5v5" })
  ]);
}

export function Wrench(props) {
  return svg(props, [
    h("path", { key: "a", d: "M14.7 6.3a4 4 0 0 0-5 5L3 18v3h3l6.7-6.7a4 4 0 0 0 5-5l-2.4 2.4-2.8-2.8Z" })
  ]);
}

export function XCircle(props) {
  return svg(props, [
    h("circle", { key: "a", cx: "12", cy: "12", r: "10" }),
    h("path", { key: "b", d: "m15 9-6 6" }),
    h("path", { key: "c", d: "m9 9 6 6" })
  ]);
}
