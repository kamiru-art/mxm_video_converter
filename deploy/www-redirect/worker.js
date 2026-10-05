// www.mxmstudio.work → mxmstudio.work, same path and query.
// One address only: localStorage and the installed app are per origin, so
// the two hosts serving the site would split each user's presets in two.
// biome-ignore lint/style/noDefaultExport: the Workers runtime looks for the default export
export default {
  fetch(request) {
    const url = new URL(request.url);
    url.hostname = 'mxmstudio.work';
    return Response.redirect(url.toString(), 301);
  },
};
