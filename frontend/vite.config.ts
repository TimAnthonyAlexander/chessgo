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
})
