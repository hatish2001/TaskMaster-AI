"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashContent = hashContent;
exports.dedupeStrings = dedupeStrings;
exports.clamp = clamp;
const crypto_1 = __importDefault(require("crypto"));
function hashContent(content) {
    return crypto_1.default.createHash("sha1").update(content).digest("hex");
}
function dedupeStrings(values) {
    return Array.from(new Set(values));
}
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
//# sourceMappingURL=utils.js.map