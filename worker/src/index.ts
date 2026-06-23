// rlmcode-site — Cloudflare Worker. rlm.quel.computer → the GitHub repo (301).
const REPO = "https://github.com/umgbhalla/rlmcode"
export default {
  fetch(): Response {
    return Response.redirect(REPO, 301)
  },
} satisfies ExportedHandler
