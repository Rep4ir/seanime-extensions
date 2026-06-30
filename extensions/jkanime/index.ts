/// <reference path="../../online-streaming-provider.d.ts" />

/**
 * JKAnime - Online Streaming Provider for jkanime.net
 *
 * Flow:
 *  1. search()         → GET /buscar/{query} (HTML scrape) or POST /ajax_search with CSRF
 *  2. findEpisodes()   → POST /ajax/episodes/{animeId}/{page} with CSRF (paginated)
 *  3. findEpisodeServer() → scrape episode page for jkplayer iframe URLs, then fetch
 *                          the player page to extract the video stream URL.
 *                          Now supports multiple servers: Mega, Streamwish, VOE, Vidhide,
 *                          Filemoon, Mixdrop, Mp4upload, Streamtape, Doodstream, etc.
 */

class Provider {

    baseUrl = "https://jkanime.net"

    getSettings(): Settings {
        const settings = {
            episodeServers: ["Desu", "Magi", "Mega", "Streamwish", "VOE", "Vidhide", "Filemoon", "Mixdrop", "Mp4upload", "Streamtape", "Doodstream"],
            supportsDub: true,
        };
        console.log("getSettings called, returning:", settings);
        return settings;
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

        const cookies = res.cookies || {}
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
     * Extract video URL from an iframe page content using multiple patterns.
     * Returns the first found URL, or empty string if none.
     */
    _extractStreamFromPage(html: string, iframeUrl: string): string {
        // Direct video file? (iframe URL itself could be the video)
        if (/\.(m3u8|mp4|webm|mkv)(\?.*)?$/i.test(iframeUrl)) {
            return iframeUrl
        }

        // Try to find a URL in common patterns
        const patterns = [
            // <source> tags
            /<source\s+src=["']([^"']+\.(?:m3u8|mp4|webm)[^"']*)["']/i,
            // JavaScript assignments
            /(?:file|src|video_url|source|url)\s*[:=]\s*["']([^"']+\.(?:m3u8|mp4|webm)[^"']*)["']/i,
            // hls.loadSource
            /hls\.loadSource\(\s*["']([^"']+\.m3u8[^"']*)["']\s*\)/i,
            // Generic src attribute
            /src=["']([^"']+\.(?:m3u8|mp4|webm)[^"']*)["']/i,
            // JSON-like config: "file":"..."
            /["']file["']\s*:\s*["']([^"']+)["']/i,
            /["']url["']\s*:\s*["']([^"']+)["']/i,
            // Playlist or video tag
            /video\s+src=["']([^"']+)["']/i,
            // Any m3u8 or mp4 in the page (fallback)
            /(https?:\/\/[^\s'"]+\.(?:m3u8|mp4)[^\s'"]*)/i,
        ]

        for (const pattern of patterns) {
            const match = html.match(pattern)
            if (match && match[1]) {
                let url = match[1]
                // If relative, resolve against iframe URL
                if (url.startsWith("/")) {
                    const base = new URL(iframeUrl)
                    url = `${base.protocol}//${base.host}${url}`
                } else if (!url.startsWith("http")) {
                    // Try to resolve relative path
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

        if (!res.ok) {
            return []
        }

        let data: any[]
        try {
            data = res.json()
        } catch (_) {
            return []
        }

        if (!Array.isArray(data)) {
            return []
        }

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
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
        })

        if (!animePageRes.ok) {
            throw new Error(`Anime page not found for slug "${slug}" (status ${animePageRes.status})`)
        }

        const animeHtml = animePageRes.text()
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

        const firstData = firstRes.json() as {
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
                    }).then((r) => r.json()),
                ),
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
        const parts = episode.id.split("::")
        const slug = parts[0]
        const epNum = parts[1]
        const episodeUrl = `${this.baseUrl}/${slug}/${epNum}/`

        // Fetch episode page to get iframe and server names
        const res = await fetch(episodeUrl, {
            headers: {
                "Referer": `${this.baseUrl}/${slug}/`,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
        })

        if (!res.ok) {
            throw new Error(`Failed to fetch episode page (status ${res.status})`)
        }

        const html = res.text()

        // Extract iframes: video[0] = '<iframe src="..." ...'
        const videoRegex = /video\[(\d+)\]\s*=\s*'<iframe[^']*src="([^"]+)"[^']*>'/g
        const iframes: Array<{ index: number; url: string }> = []
        let m: RegExpExecArray | null
        while ((m = videoRegex.exec(html)) !== null) {
            iframes.push({ index: parseInt(m[1], 10), url: m[2] })
        }

        if (iframes.length === 0) {
            throw new Error("No video sources found on episode page.")
        }

        // Extract server button names
        const serverNameRegex = /id="btn-show-(\d+)"[^>]*>([^<]+)<\/a>/g
        const serverNames: Record<number, string> = {}
        let sn: RegExpExecArray | null
        while ((sn = serverNameRegex.exec(html)) !== null) {
            serverNames[parseInt(sn[1], 10)] = sn[2].trim()
        }

        // Find target iframe for the requested server (case-insensitive)
        let targetIframe = iframes[0]
        const serverLower = _server.toLowerCase()
        for (const iframe of iframes) {
            const name = (serverNames[iframe.index] || "").toLowerCase()
            if (name === serverLower) {
                targetIframe = iframe
                break
            }
        }

        const iframeUrl = targetIframe.url
        const serverName = serverNames[targetIframe.index] || `server-${targetIframe.index}`

        // Fetch the iframe page (the player)
        const playerRes = await fetch(iframeUrl, {
            headers: {
                "Referer": episodeUrl,  // The iframe is embedded in the episode page
                "Origin": this.baseUrl,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
            // Some servers might require following redirects (fetch does by default)
        })

        if (!playerRes.ok) {
            throw new Error(`Failed to fetch player page (status ${playerRes.status})`)
        }

        // Check if response is a video file (content-type) or direct URL
        const contentType = playerRes.headers["content-type"] || ""
        if (contentType.startsWith("video/") || /\.(m3u8|mp4|webm)(\?|$)/i.test(iframeUrl)) {
            // The iframe URL itself is the video source
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

        // Otherwise parse the HTML
        const playerHtml = playerRes.text()

        // Extract stream URL using our helper
        let streamUrl = this._extractStreamFromPage(playerHtml, iframeUrl)

        // If still not found, try to look for any URL in the page that looks like a video
        if (!streamUrl) {
            // Fallback: search for any http(s) URL that contains m3u8, mp4, etc.
            const fallbackPattern = /(https?:\/\/[^\s'"]+\.(?:m3u8|mp4|webm)[^\s'"]*)/i
            const fallbackMatch = playerHtml.match(fallbackPattern)
            if (fallbackMatch && fallbackMatch[1]) {
                streamUrl = fallbackMatch[1]
            }
        }

        if (!streamUrl) {
            throw new Error(`Could not extract video stream URL from player page for server "${serverName}".`)
        }

        // Determine type
        const isM3u8 = /\.m3u8/i.test(streamUrl)
        const type: VideoSourceType = isM3u8 ? "m3u8" : "mp4" // assume mp4 if not m3u8

        return {
            server: serverName,
            headers: {
                "Referer": iframeUrl,
                "Origin": this.baseUrl,
            },
            videoSources: [
                {
                    url: streamUrl,
                    type: type,
                    quality: "default",
                    subtitles: [],
                },
            ],
        }
    }
}

// Al final del archivo, después de la clase
if (typeof window !== "undefined" && (window as any).registerProvider) {
    (window as any).registerProvider(new Provider());
}