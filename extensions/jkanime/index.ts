/// <reference path="../../online-streaming-provider.d.ts" />

/**
 * JKAnime - Online Streaming Provider for jkanime.net
 *
 * Flow:
 *  1. search()         → GET /buscar/{query} (HTML scrape) or POST /ajax_search with CSRF
 *  2. findEpisodes()   → POST /ajax/episodes/{animeId}/{page} with CSRF (paginated)
 *  3. findEpisodeServer() → scrape episode page for jkplayer iframe URLs, then fetch
 *                          the player page to extract the .m3u8 stream URL
 *
 * CSRF handling: jkanime.net requires a valid CSRF token + session cookie for its
 * AJAX endpoints. We fetch the homepage first to obtain both, then reuse them.
 */

class Provider {

    baseUrl = "https://jkanime.net"

    getSettings(): Settings {
        return {
            // "Desu" and "Magi" are the two built-in servers on jkanime.net.
            // "Desu" uses jkplayer/um, "Magi" uses jkplayer/umv — both serve m3u8.
            episodeServers: ["Desu", "Magi", "Mega", "Streamwish", "VOE", "Vidhide", "Filemoon", "Mixdrop", "Mp4upload", "Streamtape", "Doodstream"],
            supportsDub: true,
        }
    }

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    /**
     * Fetches the homepage and returns { csrfToken, cookieHeader } so subsequent
     * AJAX calls can authenticate properly.
     *
     * The engine exposes res.cookies as Record<string, string> and res.headers as
     * Record<string, string> — neither supports .get(). We build the cookie header
     * from res.cookies directly.
     */
    async _getSession(): Promise<{ csrfToken: string; cookieHeader: string }> {
        const res = await fetch(this.baseUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
        })

        const html = await res.text()

        // Extract CSRF meta tag
        const csrfMatch = html.match(/<meta name="csrf-token" content="([^"]+)"/)
        const csrfToken = csrfMatch ? csrfMatch[1] : ""

        // Build cookie header from the engine's parsed cookies map
        const cookies = res.cookies || {}
        const cookieHeader = Object.keys(cookies)
            .map((k) => `${k}=${cookies[k]}`)
            .join("; ")

        return { csrfToken, cookieHeader }
    }

    /**
     * Normalises a title for fuzzy matching against jkanime slugs/titles.
     * Strips punctuation, lowercases, collapses whitespace.
     */
    _normalise(s: string): string {
        return s
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim()
    }

    /**
     * Simple similarity score: fraction of query words present in the candidate.
     */
    _similarity(query: string, candidate: string): number {
        const qWords = this._normalise(query).split(" ")
        const cNorm = this._normalise(candidate)
        const matches = qWords.filter((w) => cNorm.includes(w)).length
        return matches / qWords.length
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
            // id carries only the slug; findEpisodes scrapes the numeric jkanime
            // ID from the anime page so we don't need to encode it here.
            id: item.slug,
            title: item.title,
            url: `${this.baseUrl}/${item.slug}/`,
            subOrDub: "sub" as SubOrDub,
        }))

        // Sort by similarity to the original query so the best match comes first.
        // This helps when AniDB titles differ from jkanime titles (e.g. season suffixes).
        results.sort((a, b) => this._similarity(opts.query, b.title) - this._similarity(opts.query, a.title))

        return results
    }

    // ---------------------------------------------------------------------------
    // findEpisodes
    // ---------------------------------------------------------------------------

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        // id is the slug returned by search() (e.g. "naruto").
        const slug = id

        // Step 1: fetch the anime page to extract the numeric jkanime ID from
        // the data-anime attribute (e.g. <div data-anime="20">).
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

        // Step 2: get CSRF token + session cookie for the AJAX endpoints.
        const { csrfToken, cookieHeader } = await this._getSession()

        const commonHeaders = {
            "X-Requested-With": "XMLHttpRequest",
            "X-CSRF-TOKEN": csrfToken,
            "Referer": `${this.baseUrl}/${slug}/`,
            "Cookie": cookieHeader,
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        }

        // Step 3: fetch first episode page to learn total pages.
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
                    // slug::episodeNumber so findEpisodeServer can build the URL
                    id: `${slug}::${item.number}`,
                    number: item.number,
                    url: `${this.baseUrl}/${slug}/${item.number}/`,
                    title: item.title || `Episodio ${item.number}`,
                })
            }
        }

        pushPage(firstData.data)

        // Step 4: fetch remaining pages in parallel.
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
        // id format: "slug::episodeNumber"
        const parts = episode.id.split("::")
        const slug = parts[0]
        const epNum = parts[1]

        const episodeUrl = `${this.baseUrl}/${slug}/${epNum}/`

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

        // Extract all video[N] = '<iframe ... src="URL" ...' entries
        // jkanime embeds them as: video[0] = '...'; video[1] = '...';
        const videoRegex = /video\[(\d+)\]\s*=\s*'<iframe[^']*src="([^"]+)"[^']*>'/g
        const iframes: Array<{ index: number; url: string }> = []
        let m: RegExpExecArray | null
        while ((m = videoRegex.exec(html)) !== null) {
            iframes.push({ index: parseInt(m[1], 10), url: m[2] })
        }

        if (iframes.length === 0) {
            throw new Error("No video sources found on episode page.")
        }

        // Also extract server button names to map index → server name
        // <a id="btn-show-0" data-id="0" ... >Desu</a>
        const serverNameRegex = /id="btn-show-(\d+)"[^>]*>([^<]+)<\/a>/g
        const serverNames: Record<number, string> = {}
        let sn: RegExpExecArray | null
        while ((sn = serverNameRegex.exec(html)) !== null) {
            serverNames[parseInt(sn[1], 10)] = sn[2].trim()
        }

        // Determine which iframe to use based on requested server name
        let targetIframe = iframes[0]
        const serverLower = _server.toLowerCase()

        for (const iframe of iframes) {
            const name = (serverNames[iframe.index] || "").toLowerCase()
            if (name === serverLower) {
                targetIframe = iframe
                break
            }
        }

        // Fetch the jkplayer page to extract the .m3u8 URL
        const playerRes = await fetch(targetIframe.url, {
            headers: {
                "Referer": `${this.baseUrl}/`,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
        })

        if (!playerRes.ok) {
            throw new Error(`Failed to fetch player page (status ${playerRes.status})`)
        }

        const playerHtml = playerRes.text()

        // The player page embeds the stream URL in one of these patterns:
        //   url: 'https://...m3u8?...'
        //   <source src='https://...m3u8?...' type='application/x-mpegURL'>
        //   hls.loadSource('https://...m3u8?...')
        const m3u8Patterns = [
            /url:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/,
            /<source\s+src=['"]([^'"]+\.m3u8[^'"]*)['"]/,
            /hls\.loadSource\(\s*['"]([^'"]+\.m3u8[^'"]*)['"]\s*\)/,
            /['"]([^'"]+\.m3u8[^'"]*)['"]/,
        ]

        let streamUrl = ""
        for (const pattern of m3u8Patterns) {
            const match = playerHtml.match(pattern)
            if (match && match[1]) {
                streamUrl = match[1]
                break
            }
        }

        if (!streamUrl) {
            throw new Error("Could not extract stream URL from player page.")
        }

        const serverName = serverNames[targetIframe.index] || `server-${targetIframe.index}`

        return {
            server: serverName,
            headers: {
                "Referer": targetIframe.url,
                "Origin": this.baseUrl,
            },
            videoSources: [
                {
                    url: streamUrl,
                    type: "m3u8",
                    quality: "default",
                    subtitles: [],
                },
            ],
        }
    }
}
