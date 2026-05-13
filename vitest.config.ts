import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'examples/**/*.test.ts'],
        setupFiles: ['./tests/mocks/setup.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html', 'lcov'],
            include: ['src/**/*.ts', 'cli/**/*.ts'],
            exclude: [
                'src/**/*.test.ts',
                'src/**/index.ts',
                'src/types/**',
                'cli/index.ts',
                '**/*.d.ts',
            ],
            thresholds: {
                lines: 100,
                functions: 100,
                branches: 100,
                statements: 100,
            },
        },
    },
});
