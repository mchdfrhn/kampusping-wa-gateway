import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Blocks WhatsApp/GitHub access (Baileys socket, version fetch, non-loopback fetch).
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
  },
});
