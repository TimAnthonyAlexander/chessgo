import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Frontend dev server binds 127.0.0.1:6465 (SPEC §3: API on 6464, frontend 6465).
export default defineConfig({
    plugins: [react()],
    server: {
        host: '127.0.0.1',
        port: 6465,
        strictPort: true,
    },
    build: {
        rollupOptions: {
            output: {
                // Split slow-changing vendor code into stable chunks so an app
                // edit doesn't bust the whole vendor cache. react/react-dom stay
                // in the default vendor chunk (not carved out) to avoid init-order
                // hazards; MUI+emotion, react-router, and chess.js each get their
                // own — chess.js pairs with the route code-splitting so it's only
                // fetched on analysis/editor routes.
                manualChunks(id) {
                    if (!id.includes('node_modules')) return undefined
                    if (id.includes('/chess.js/')) return 'chess'
                    if (id.includes('/react-router') || id.includes('/@remix-run/router/'))
                        return 'router'
                    if (id.includes('/@mui/') || id.includes('/@emotion/')) return 'mui'
                    return undefined
                },
            },
        },
    },
})
