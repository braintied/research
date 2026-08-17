/**
 * YouTube channel ingestion modules — Data API v3 channel/playlist catalog,
 * video metadata, and comment trees. Keys arrive as function arguments.
 */

export {
  listChannelVideos,
  getChannelPlaylists,
  getPlaylistVideoIds,
  buildPlaylistMembership,
} from './channel.js';
export type { ChannelVideoRef, ChannelPlaylist } from './channel.js';

export { getVideoMetadata } from './metadata.js';
export type { YoutubeVideoMetadata } from './metadata.js';

export { getVideoComments } from './comments.js';
export type { YoutubeComment } from './comments.js';
