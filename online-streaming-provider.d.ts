type SubOrDub = "sub" | "dub" | "both"

type SearchResult = {
  id: string
  title: string
  url: string
  subOrDub: SubOrDub
}

type EpisodeDetails = {
  id: string
  number: number
  url: string
  title?: string
}

type VideoSource = {
  url: string
  type: "mp4" | "m3u8" | "unknown"
  quality: string
  label?: string
  subtitles: VideoSubtitle[]
}

type VideoSubtitle = {
  id: string
  url: string
  language: string
  isDefault: boolean
}

type EpisodeServer = {
  server: string
  headers: { [key: string]: string }
  videoSources: VideoSource[]
}

type SearchOptions = {
  media: Media
  query: string
  dub: boolean
  year?: number
}

type Settings = {
  episodeServers: string[]
  supportsDub: boolean
}

declare class Media {
  id: number
  idMal: number
  title: MediaTitle
  description: string
  coverImage: MediaCoverImage
  bannerImage: string
  episodes: number | null
  season: string
  seasonYear: number
  status: string
  format: string
  genres: string[]
  averageScore: number
  popularity: number
  studios: MediaStudio[]
  nextAiringEpisode: MediaNextAiringEpisode | null
  tags: MediaTag[]
  trailer: MediaTrailer | null
  externalLinks: MediaExternalLink[]
  relations: MediaRelation[]
  characters: MediaCharacter[]
  staff: MediaStaff[]
  mediaListEntry: MediaListEntry | null
}

declare class MediaTitle {
  romaji: string
  english: string | null
  native: string
  userPreferred: string
}

declare class MediaCoverImage {
  large: string
  medium: string
  color: string | null
}

declare class MediaStudio {
  edges: MediaStudioEdge[]
}

declare class MediaStudioEdge {
  node: Studio
}

declare class Studio {
  id: number
  name: string
  isAnimationStudio: boolean
}

declare class MediaNextAiringEpisode {
  id: number
  episode: number
  timeUntilAiring: number
  airingAt: number
}

declare class MediaTag {
  id: number
  name: string
  description: string | null
  category: string
  rank: number
  isGeneralSpoiler: boolean
  isMediaSpoiler: boolean
  isAdult: boolean
}

declare class MediaTrailer {
  id: string
  site: string
  thumbnail: string | null
}

declare class MediaExternalLink {
  id: number
  url: string
  site: string
  type: string
  language: string | null
  color: string | null
  icon: string | null
  notes: string | null
  isDisabled: boolean
}

declare class MediaRelation {
  edges: MediaRelationEdge[]
}

declare class MediaRelationEdge {
  relationType: string
  node: Media
}

declare class MediaCharacter {
  edges: MediaCharacterEdge[]
}

declare class MediaCharacterEdge {
  node: Character
  role: string
  voiceActors: VoiceActor[]
}

declare class Character {
  id: number
  name: CharacterName
  image: CharacterImage
  description: string | null
}

declare class CharacterName {
  first: string | null
  last: string | null
  full: string
  native: string
  alternative: string[]
  alternativeSpoiler: string[]
  userPreferred: string
}

declare class CharacterImage {
  large: string
  medium: string
}

declare class VoiceActor {
  id: number
  name: VoiceActorName
  image: VoiceActorImage
  language: string
}

declare class VoiceActorName {
  first: string | null
  last: string | null
  full: string
  native: string
  alternative: string[]
  userPreferred: string
}

declare class VoiceActorImage {
  large: string
  medium: string
}

declare class MediaStaff {
  edges: MediaStaffEdge[]
}

declare class MediaStaffEdge {
  node: Staff
  role: string
}

declare class Staff {
  id: number
  name: StaffName
  image: StaffImage
  primaryOccupations: string[]
}

declare class StaffName {
  first: string | null
  last: string | null
  full: string
  native: string
  alternative: string[]
  userPreferred: string
}

declare class StaffImage {
  large: string
  medium: string
}

declare class MediaListEntry {
  id: number
  status: string
  score: number | null
  progress: number
  progressVolumes: number
  repeat: number
  priority: number
  notes: string | null
  hiddenFromStatusLists: boolean
  customLists: string[]
  advancedScores: AdvancedScores | null
  startedAt: FuzzyDate | null
  completedAt: FuzzyDate | null
  updatedAt: number
  createdAt: number
}

declare class AdvancedScores {
  story: number | null
  characters: number | null
  visuals: number | null
  audio: number | null
  enjoyment: number | null
}

declare class FuzzyDate {
  year: number | null
  month: number | null
  day: number | null
}

declare abstract class AnimeProvider {
    search(opts: SearchOptions): Promise<SearchResult[]>

    findEpisodes(id: string): Promise<EpisodeDetails[]>

    findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer>

    getSettings(): Settings
}
