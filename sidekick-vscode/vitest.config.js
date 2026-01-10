"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("vitest/config");
exports.default = (0, config_1.defineConfig)({
    test: {
        globals: true,
        environment: "node",
        include: ["src/**/*.test.ts"],
        coverage: {
            reporter: ["text", "json", "html"],
            exclude: ["node_modules", "out"],
        },
    },
});
//# sourceMappingURL=vitest.config.js.map