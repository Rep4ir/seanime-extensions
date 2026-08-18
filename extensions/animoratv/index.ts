/// <reference path="../../online-streaming-provider.d.ts" />

/**
 * AnimoraTV - Online Streaming Provider
 * 
 * API Base: https://api.playadoradarp.xyz/port/25619
 * 
 * Endpoints:
 * - Search: /api/busqueda?termino={query}&pagina={page}&limite=30
 * - Anime details: /api/animes/{slug}
 * - Episodes: /api/animes/{slug}/episodios
 * - Video sources: /api/video/{animeSlug}/{episodeNumber}/fuentes
 */

class Provider {
    baseUrl = "https://www.animoratv.com"
    apiBase = "https://api.playadoradarp.xyz/port/25619"

    private headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        "Origin": "https://www.animoratv.com",
        "Referer": "https://www.animoratv.com/",
    }

    getSettings(): Settings {
        return {
            episodeServers: ["default"],
            supportsDub: false,
        }
    }

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    private async _apiRequest<T>(endpoint: string, options?: FetchOptions): Promise<T> {
        const url = `${this.apiBase}${endpoint}`
        const res = await fetch(url, {
            ...options,
            headers: {
                ...this.headers,
                "Content-Type": "application/json",
                ...options?.headers,
            },
        })

        if (!res.ok) {
            const text = await res.text()
            throw new Error(`API request failed: ${res.status} ${res.statusText} - ${text}`)
        }

        const data = await res.json()
        
        if (data.success === false) {
            throw new Error(data.mensaje || "API error")
        }

        return data.data
    }

    private _normalise(s: string): string {
        return s
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim()
    }

    private _similarity(query: string, candidate: string): number {
        const qWords = this._normalise(query).split(" ")
        const cNorm = this._normalise(candidate)
        const matches = qWords.filter((w) => cNorm.includes(w)).length
        return matches / qWords.length
    }

    private _extractStreamFromPage(html: string, iframeUrl: string): string {
        if (/\.(m3u8|mp4|webm|mkv)(\?.*)?$/i.test(iframeUrl)) {
            return iframeUrl
        }

        const nestedIframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i)
        if (nestedIframeMatch && nestedIframeMatch[1]) {
            const nestedUrl = nestedIframeMatch[1]
            if (/\.(m3u8|mp4|webm)(\?.*)?$/i.test(nestedUrl)) {
                return nestedUrl
            }
            return nestedUrl
        }

        const patterns = [
            /(?:file|src|video_url|source|url)\s*[:=]\s*["']([^"']+\.(?:m3u8|mp4|webm)[^"']*)["']/i,
            /<source\s+src=["']([^"']+\.(?:m3u8|mp4|webm)[^"']*)["']/i,
            /hls\.loadSource\(\s*["']([^"']+\.m3u8[^"']*)["']\s*\)/i,
            /src=["']([^"']+\.(?:m3u8|mp4|webm)[^"']*)["']/i,
            /["']file["']\s*:\s*["']([^"']+)["']/i,
            /["']url["']\s*:\s*["']([^"']+)["']/i,
            /video\s+src=["']([^"']+)["']/i,
            /(https?:\/\/[^\s'"]+\.(?:m3u8|mp4|webm)[^\s'"]*)/i,
        ]

        for (const p of patterns) {
            const m = html.match(p)
            if (m && m[1]) {
                let url = m[1]
                if (url.startsWith("/")) {
                    const base = new URL(iframeUrl)
                    url = `${base.protocol}//${base.host}${url}`
                } else if (!url.startsWith("http")) {
                    try {
                        url = new URL(url, iframeUrl).toString()
                    } catch (_) { /* ignore */ }
                }
                return url
            }
        }

        return ""
    }

    // ---------------------------------------------------------------------------
    // search
    // ---------------------------------------------------------------------------

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const query = opts.query
        if (!query || !query.trim()) {
            return []
        }

        try {
            const data = await this._apiRequest<{
                animes: Array<{
                    _id: string
                    slug: string
                    titulo: string
                    tituloIngles?: string
                    portada: string
                    anio?: number
                    tipo?: string
                    estado?: string
                    rating?: number
                    generos?: string[]
                }>
            }>(`/api/busqueda?termino=${encodeURIComponent(query)}&pagina=1&limite=30`)

            if (!data?.animes || !Array.isArray(data.animes)) {
                return []
            }

            const results: SearchResult[] = data.animes.map((item) => ({
                id: item.slug,
                title: item.titulo || item.tituloIngles || "Unknown",
                url: `${this.baseUrl}/anime/${item.slug}/`,
                subOrDub: "sub" as SubOrDub,
            }))

            results.sort((a, b) => this._similarity(query, b.title) - this._similarity(query, a.title))
            return results
        } catch (e) {
            console.error("AnimoraTV search error:", e)
            return []
        }
    }

    // ---------------------------------------------------------------------------
    // findEpisodes
    // ---------------------------------------------------------------------------

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const slug = id

        try {
            const data = await this._apiRequest<{
                anime: {
                    _id: string
                    slug: string
                    titulo: string
                    totalEpisodios?: number
                }
                episodios: Array<{
                    _id: string
                    numero: number
                    titulo?: string
                    fechaEmision?: string
                    descripcion?: string
                    miniatura?: string
                }>
            }>(`/api/animes/${encodeURIComponent(slug)}/episodios`)

            if (!data?.episodios || !Array.isArray(data.episodios)) {
                throw new Error("No episodes found")
            }

            const episodes: EpisodeDetails[] = []

            for (const ep of data.episodios) {
                if (!Number.isInteger(ep.numero)) continue
                episodes.push({
                    id: `${slug}::${ep.numero}`,
                    number: ep.numero,
                    url: `${this.baseUrl}/anime/${slug}/episodio/${ep.numero}/`,
                    title: ep.titulo || `Episodio ${ep.numero}`,
                })
            }

            if (episodes.length === 0) {
                throw new Error("No episodes found")
            }

            episodes.sort((a, b) => a.number - b.number)
            return episodes
        } catch (e) {
            console.error("AnimoraTV findEpisodes error:", e)
            throw new Error(`Failed to fetch episodes: ${e instanceof Error ? e.message : String(e)}`)
        }
    }

    // ---------------------------------------------------------------------------
    // findEpisodeServer
    // ---------------------------------------------------------------------------

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        const parts = episode.id.split("::")
        if (parts.length !== 2) {
            throw new Error(`Invalid episode id format: "${episode.id}"`)
        }
        const slug = parts[0]
        const epNum = parts[1]
        if (!epNum || isNaN(Number(epNum))) {
            throw new Error(`Invalid episode number: "${epNum}"`)
        }

        try {
            const data = await this._apiRequest<{
                fuentes: Array<{
                    indiceFuente: number
                    totalServidores: number
                    servidores: Array<{
                        indiceServidor: number
                        urlVideo: string
                        calidad: string
                        proveedor: string
                    }>
                }>
                hlsSource?: {
                    disponible: boolean
                    motivo?: string
                }
            }>(`/api/video/${encodeURIComponent(slug)}/${epNum}/fuentes`)

            if (!data?.fuentes || !Array.isArray(data.fuentes) || data.fuentes.length === 0) {
                throw new Error("No video sources found")
            }

            const videoSources: VideoSource[] = []

            for (const fuente of data.fuentes) {
                for (const servidor of fuente.servidores) {
                    const streamUrl = servidor.urlVideo
                    if (!streamUrl) continue

                    const isM3u8 = /\.m3u8/i.test(streamUrl) || servidor.proveedor === "HLS"
                    const quality = servidor.calidad || (isM3u8 ? "auto" : "default")

                    // Only include direct playable sources (m3u8/mp4), skip file hosters requiring JS
                    if (!isM3u8 && !/\.(mp4|webm)(\?.*)?$/i.test(streamUrl)) {
                        continue
                    }

                    videoSources.push({
                        url: streamUrl,
                        type: isM3u8 ? "m3u8" : "mp4",
                        quality,
                        label: servidor.proveedor,
                        subtitles: [],
                    })
                }
            }

            if (videoSources.length === 0) {
                throw new Error("No playable video sources found (need m3u8/mp4)")
            }

            return {
                server: _server || "default",
                headers: {
                    "Referer": `${this.baseUrl}/anime/${slug}/episodio/${epNum}/`,
                    "Origin": this.baseUrl,
                    "User-Agent": this.headers["User-Agent"],
                },
                videoSources,
            }
        } catch (e) {
            console.error("AnimoraTV findEpisodeServer error:", e)
            throw new Error(`Failed to fetch video sources: ${e instanceof Error ? e.message : String(e)}`)
        }
    }
}

if (typeof window !== "undefined" && (window as any).registerProvider) {
    (window as any).registerProvider(new Provider())
}