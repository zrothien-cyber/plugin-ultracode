// JSON payloads, user workflow exports, and CLI option bags enter through
// deliberately dynamic boundaries. The engine core narrows them before using
// stable behavior; compatibility modules retain their flexible public shape.
type RuntimeRecord = Record<string, any>;
type RuntimeValue = any;
