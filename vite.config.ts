import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5180, host: '127.0.0.1' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
} as any);
