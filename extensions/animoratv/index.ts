/// <reference path="../../online-streaming-provider.d.ts" />
/// <reference path="../../core.d.ts" />

class Provider {
  private baseUrl: string = "https://api.playadoradarp.xyz/port/25619"
  private siteUrl: string = "https://www.animoratv.com"
  private headers: { [key: string]: string } = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Referer": "https://www.animoratv.com/",
    "Origin": "https://www.animoratv.com"
  }

  getSettings(): Settings {
    return {
      episodeServers: ["default", "source1", "source2", "source3", "source4", "source5", "source6"],
      supportsDub: false
    }
  }

  async search(opts: SearchOptions): Promise<SearchResult[]> {
    const query = encodeURIComponent(opts.query)
    const searchUrl = `${this.baseUrl}/api/busqueda?termino=${query}&pagina=1&limite=30`

    const response = await fetch(searchUrl, { headers: this.headers })
    const data = await response.json()

    if (!data.success || !data.data?.animes) {
      return []
    }

    const results: SearchResult[] = []

    for (const anime of data.data.animes) {
      const subOrDub: SubOrDub = "sub"
      results.push({
        id: anime.slug,
        title: anime.titulo,
        url: `${this.siteUrl}/anime/${anime.slug}`,
        subOrDub: subOrDub
      })
    }

    return results
  }

  async findEpisodes(id: string): Promise<EpisodeDetails[]> {
    const episodesUrl = `${this.baseUrl}/api/animes/${encodeURIComponent(id)}/episodios`

    const response = await fetch(episodesUrl, { headers: this.headers })
    const data = await response.json()

    if (!data.success || !data.data?.episodios) {
      return []
    }

    const episodes: EpisodeDetails[] = []

    for (const ep of data.data.episodios) {
      episodes.push({
        id: `${id}-${ep.numero}`,
        number: ep.numero,
        url: `${this.siteUrl}/anime/${id}/episodio/${ep.numero}`,
        title: ep.titulo || `Episodio ${ep.numero}`
      })
    }

    return episodes.sort((a, b) => a.number - b.number)
  }

  async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
    const match = episode.url.match(/\/anime\/([^/]+)\/episodio\/(\d+)/)
    if (!match) {
      throw new Error("Invalid episode URL format")
    }

    const animeSlug = match[1]
    const episodeNumber = match[2]

    const sourcesUrl = `${this.baseUrl}/api/video/${encodeURIComponent(animeSlug)}/${episodeNumber}/fuentes`

    const response = await fetch(sourcesUrl, { headers: this.headers })
    const data = await response.json()

    if (!data.success || !data.data?.fuentes) {
      throw new Error("No video sources found")
    }

    const videoSources: VideoSource[] = []
    const sourceIndex = parseInt(server.replace("source", "")) - 1

    const fuentes = data.data.fuentes
    const targetFuente = fuentes[sourceIndex] || fuentes[0]

    if (targetFuente && targetFuente.servidores) {
      for (const servidor of targetFuente.servidores) {
        const type = servidor.urlVideo.includes(".m3u8") || servidor.tipo === "hls" ? "m3u8" : "mp4"
        const quality = servidor.calidad || "1080p"

        videoSources.push({
          url: servidor.urlVideo,
          type: type,
          quality: quality,
          label: servidor.proveedor,
          subtitles: []
        })
      }
    }

    if (data.data.hlsSource?.disponible && data.data.hlsSource.url) {
      videoSources.push({
        url: data.data.hlsSource.url,
        type: "m3u8",
        quality: "1080p",
        label: "HLS (Soft Subs)",
        subtitles: []
      })
    }

    return {
      server: server,
      headers: {
        "Referer": this.siteUrl,
        "User-Agent": this.headers["User-Agent"]
      },
      videoSources: videoSources
    }
  }
}