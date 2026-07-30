/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_API_URL?: string
    readonly VITE_LOCAL_ENGINE_NET_URL?: string
}

interface ImportMeta {
    readonly env: ImportMetaEnv
}
