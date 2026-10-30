# PulseDeck MP3

Paste YouTube links, get MP3 files numbered 01, 02, 03 in the same order as the links.

## Run

    npm install --legacy-peer-deps      # or: bun install
    npm run dev                         # http://localhost:3000

Production:

    npx vite build
    NODE_ENV=production npm start

## Converter (important for long videos)

The server converts videos itself with yt-dlp and ffmpeg. This has no 20 minute limit
and does not depend on any third-party website. Install both on the machine that runs the server:

    pip install -U yt-dlp               # or download the binary from the yt-dlp GitHub releases
    sudo apt install ffmpeg             # or: brew install ffmpeg

Check which converter is active: open /api/health, or read the first line printed at startup.

If yt-dlp is not installed, the server falls back to the third-party converter cnvmp3.com
(ENGINE=auto). That fallback is unofficial and can break at any time, and it only gives 128 kbps
for videos longer than 20 minutes. Set ENGINE=ytdlp to never use it.

Keep yt-dlp up to date (`pip install -U yt-dlp`). YouTube changes often and old versions stop working.

## Troubleshooting

- "YouTube is asking this server to prove it is not a bot": common on cloud/datacenter servers.
  Export cookies from a logged-in browser (Netscape format) and set YTDLP_COOKIES=/path/cookies.txt.
  Running the server on your own computer or home connection usually avoids this.
- Nothing converts: check /api/health and that `ffmpeg -version` works for the same user.
- All settings are listed in .env.example.

## Notes

- Files are numbered by their position in the list, so a failed video leaves a gap (01, 02, 04)
  and a retry slots back in as 03.
- ZIP is built in the browser, so it holds every MP3 in memory. For long videos use Download all.
