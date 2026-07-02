/// <reference path="../../online-streaming-provider.d.ts" />

/**
 * JKAnime - Online Streaming Provider for jkanime.net
 * 
 * Soporta:
 *   - Desu: reproductor interno (jkplayer/um) → .m3u8
 *   - Magi: reproductor interno (jkplayer/umv) → .m3u8
 * 
 * Otros servidores (Streamwish, VOE, Vidhide, etc.) no son compatibles porque
 * requieren ejecución de JavaScript para obtener la URL del video.
 */

class Provider {

    baseUrl = "https://jkanime.net"

    getSettings(): Settings {
        return {
            episodeServers: ["Desu", "Magi"],
            supportsDub: true,
        }
    }

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    async _getSession(): Promise<{ csrfToken: string; cookieHeader: string }> {
        const res = await fetch(this.baseUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
        })
        const html = await res.text()
        const csrfMatch = html.match(/<meta name="csrf-token" content="([^"]+)"/)
        const csrfToken = csrfMatch ? csrfMatch[1] : ""

        const cookies = (res as any).cookies || {}
        const cookieHeader = Object.keys(cookies)
            .map((k) => `${k}=${cookies[k]}`)
            .join("; ")

        return { csrfToken, cookieHeader }
    }

    _normalise(s: string): string {
        return s
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim()
    }

    _similarity(query: string, candidate: string): number {
        const qWords = this._normalise(query).split(" ")
        const cNorm = this._normalise(candidate)
        const matches = qWords.filter((w) => cNorm.includes(w)).length
        return matches / qWords.length
    }

    /**
     * Extrae la URL del stream de la página del reproductor (para Desu/Magi).
     */
    _extractStreamFromPage(html: string, iframeUrl: string): string {
        if (/\.(m3u8|mp4|webm|mkv)(\?.*)?$/i.test(iframeUrl)) {
            return iframeUrl
        }

        const nestedIframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i)
        if (nestedIframeMatch && nestedIframeMatch[1]) {
            const nestedUrl = nestedIframeMatch[1]
            if (/\.(m3u8|mp4|webm)(\?.*)?$/i.test(nestedUrl)) {
                return nestedUrl
            }
            // Podría ser otro iframe, pero no seguimos recursivamente por simplicidad
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
        const { csrfToken, cookieHeader } = await this._getSession()

        const res = await fetch(`${this.baseUrl}/ajax_search`, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "X-Requested-With": "XMLHttpRequest",
                "X-CSRF-TOKEN": csrfToken,
                "Referer": this.baseUrl,
                "Cookie": cookieHeader,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
            body: `q=${encodeURIComponent(opts.query)}`,
        })

        if (!res.ok) return []

        let data: any[]
        try {
            data = await res.json()
        } catch (_) {
            return []
        }

        if (!Array.isArray(data)) return []

        const results: SearchResult[] = data.map((item: any) => ({
            id: item.slug,
            title: item.title,
            url: `${this.baseUrl}/${item.slug}/`,
            subOrDub: "sub" as SubOrDub,
        }))

        results.sort((a, b) => this._similarity(opts.query, b.title) - this._similarity(opts.query, a.title))
        return results
    }

    // ---------------------------------------------------------------------------
    // findEpisodes
    // ---------------------------------------------------------------------------

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const slug = id

        const animePageRes = await fetch(`${this.baseUrl}/${slug}/`, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
        })
        if (!animePageRes.ok) {
            throw new Error(`Anime page not found for slug "${slug}" (status ${animePageRes.status})`)
        }

        const animeHtml = await animePageRes.text()
        const animeIdMatch = animeHtml.match(/data-anime="(\d+)"/)
        if (!animeIdMatch) {
            throw new Error(`Could not find numeric anime ID on page for slug "${slug}"`)
        }
        const animeId = animeIdMatch[1]

        const { csrfToken, cookieHeader } = await this._getSession()

        const commonHeaders = {
            "X-Requested-With": "XMLHttpRequest",
            "X-CSRF-TOKEN": csrfToken,
            "Referer": `${this.baseUrl}/${slug}/`,
            "Cookie": cookieHeader,
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        }

        const firstRes = await fetch(`${this.baseUrl}/ajax/episodes/${animeId}/1`, {
            method: "POST",
            headers: commonHeaders,
            body: `_token=${encodeURIComponent(csrfToken)}`,
        })
        if (!firstRes.ok) {
            throw new Error(`Failed to fetch episodes (status ${firstRes.status})`)
        }

        const firstData = await firstRes.json() as {
            data: Array<{ id: number; number: number; title: string }>
            last_page: number
        }

        const episodes: EpisodeDetails[] = []

        const pushPage = (items: Array<{ id: number; number: number; title: string }>) => {
            for (const item of items) {
                if (!Number.isInteger(item.number)) continue
                episodes.push({
                    id: `${slug}::${item.number}`,
                    number: item.number,
                    url: `${this.baseUrl}/${slug}/${item.number}/`,
                    title: item.title || `Episodio ${item.number}`,
                })
            }
        }

        pushPage(firstData.data)

        if (firstData.last_page > 1) {
            const pageNums = Array.from({ length: firstData.last_page - 1 }, (_, i) => i + 2)
            const pageResults = await Promise.all(
                pageNums.map((p) =>
                    fetch(`${this.baseUrl}/ajax/episodes/${animeId}/${p}`, {
                        method: "POST",
                        headers: commonHeaders,
                        body: `_token=${encodeURIComponent(csrfToken)}`,
                    }).then((r) => r.json())
                )
            ) as Array<{ data: Array<{ id: number; number: number; title: string }> }>

            for (const page of pageResults) {
                if (page && page.data) pushPage(page.data)
            }
        }

        if (episodes.length === 0) {
            throw new Error("No episodes found.")
        }

        episodes.sort((a, b) => a.number - b.number)
        return episodes
    }

    // ---------------------------------------------------------------------------
    // findEpisodeServer
    // ---------------------------------------------------------------------------

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        console.log("🔍 findEpisodeServer called for server:", _server)

        const parts = episode.id.split("::")
        if (parts.length !== 2) {
            throw new Error(`Invalid episode id format: "${episode.id}"`)
        }
        const slug = parts[0]
        const epNum = parts[1]
        if (!epNum || isNaN(Number(epNum))) {
            throw new Error(`Invalid episode number: "${epNum}"`)
        }

        const episodeUrl = `${this.baseUrl}/${slug}/${epNum}/`

        // Obtener la página del episodio
        const res = await fetch(episodeUrl, {
            headers: {
                "Referer": `${this.baseUrl}/${slug}/`,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
        })
        if (!res.ok) {
            throw new Error(`Failed to fetch episode page (status ${res.status})`)
        }
        const html = await res.text()

        // Extraer todos los iframes: video[0] = '<iframe ...'
        const videoRegex = /video\[(\d+)\]\s*=\s*'<iframe[^']*src="([^"]+)"[^']*>'/g
        const iframes: Array<{ index: number; url: string }> = []
        let m: RegExpExecArray | null
        while ((m = videoRegex.exec(html)) !== null) {
            iframes.push({ index: parseInt(m[1], 10), url: m[2] })
        }
        if (iframes.length === 0) {
            throw new Error("No video sources found on episode page.")
        }

        // Extraer nombres de servidores (botones)
        const serverNameRegex = /id="btn-show-(\d+)"[^>]*>([^<]+)<\/a>/g
        const serverNames: Record<number, string> = {}
        let sn: RegExpExecArray | null
        while ((sn = serverNameRegex.exec(html)) !== null) {
            serverNames[parseInt(sn[1], 10)] = sn[2].trim().toLowerCase()
        }

        // Seleccionar el iframe correspondiente al servidor solicitado
        let targetIframe = iframes[0]
        const serverLower = _server.toLowerCase()
        for (const iframe of iframes) {
            const name = serverNames[iframe.index] || ""
            if (name === serverLower) {
                targetIframe = iframe
                break
            }
        }

        const iframeUrl = targetIframe.url
        const serverName = serverNames[targetIframe.index] || _server

        // Obtener la página del reproductor
        const playerRes = await fetch(iframeUrl, {
            headers: {
                "Referer": episodeUrl,
                "Origin": this.baseUrl,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
        })
        if (!playerRes.ok) {
            throw new Error(`Failed to fetch player page (status ${playerRes.status})`)
        }

        // Si la respuesta es un video directo, devolverlo
        const contentType = (playerRes as any).headers["content-type"] || ""
        if (contentType.startsWith("video/") || /\.(m3u8|mp4|webm)(\?|$)/i.test(iframeUrl)) {
            return {
                server: serverName,
                headers: {
                    "Referer": episodeUrl,
                    "Origin": this.baseUrl,
                },
                videoSources: [
                    {
                        url: iframeUrl,
                        type: iframeUrl.includes(".m3u8") ? "m3u8" : "mp4",
                        quality: "default",
                        subtitles: [],
                    },
                ],
            }
        }

        const playerHtml = await playerRes.text()
        let streamUrl = this._extractStreamFromPage(playerHtml, iframeUrl)

        if (!streamUrl) {
            const fallbackMatch = playerHtml.match(/(https?:\/\/[^\s'"]+\.(?:m3u8|mp4|webm)[^\s'"]*)/i)
            if (fallbackMatch && fallbackMatch[1]) {
                streamUrl = fallbackMatch[1]
            }
        }

        if (!streamUrl) {
            throw new Error(`Could not extract video stream URL from player page for server "${serverName}".`)
        }

        console.log(`🎬 Extracted stream URL: ${streamUrl}`)
        const isM3u8 = /\.m3u8/i.test(streamUrl)

        return {
            server: serverName,
            headers: {
                "Referer": iframeUrl,
                "Origin": this.baseUrl,
            },
            videoSources: [
                {
                    url: streamUrl,
                    type: isM3u8 ? "m3u8" : "mp4",
                    quality: "default",
                    subtitles: [],
                },
            ],
        }
    }
}

if (typeof window !== "undefined" && (window as any).registerProvider) {
    (window as any).registerProvider(new Provider())
}