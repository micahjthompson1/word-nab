// Settings you might want to change. Nothing here is secret: a Spotify client
// ID is a public identifier, and the PKCE login flow needs no client secret.

export const CONFIG = {
  // From https://developer.spotify.com/dashboard → your app → Client ID.
  spotifyClientId: '74fd0dba781e434dad39a8494e5426b9',

  // The only permission the app asks for.
  spotifyScope: 'user-read-recently-played',

  // How many recent plays to ask Spotify for (50 is the most it returns).
  // Repeat plays of the same song are merged, so the list is usually shorter.
  recentPlays: 50,

  // Lyrics lookups running at once. Kept low to be a polite API client.
  lyricsConcurrency: 3,
};
