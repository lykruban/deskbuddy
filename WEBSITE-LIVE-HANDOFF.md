# DeskBuddy — make the new website live (server handoff)

> Paste this WHOLE file into the Claude Code session on the Ubuntu server.
> Goal: deploy the latest `main` (full multi-page website + new feedback API) to
> deskbuddy.yuvexel.com / api.yuvexel.com, and upgrade the static web server so the
> site's VIDEOS stream correctly.

You are updating an EXISTING deployment (everything already runs — cloudflared tunnel,
`deskbuddy-api` and `deskbuddy-web` systemd services, repo at `/opt/deskbuddy`, data at
`/var/lib/deskbuddy`). Do these steps:

## 1. Pull the latest code
```
cd /opt/deskbuddy
sudo git pull
```
- If it complains about local changes: `sudo git checkout -- . && sudo git pull`
- If "dubious ownership": `sudo git config --global --add safe.directory /opt/deskbuddy`

## 2. Upgrade the static web server (IMPORTANT — the site now has videos)
The current `/opt/deskbuddy/web-main.js` lacks video MIME types and HTTP Range support,
so the new hero/gallery MP4s won't play reliably. Replace its contents with:

```js
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT='/opt/deskbuddy/website', PORT=8080;
const T={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif',
  '.svg':'image/svg+xml','.mp4':'video/mp4','.webm':'video/webm','.ico':'image/x-icon',
  '.json':'application/json'};
http.createServer((q,s)=>{
  let p=decodeURIComponent(q.url.split('?')[0]); if(p==='/')p='/index.html';
  const fp=path.normalize(path.join(ROOT,p));
  if(!fp.startsWith(ROOT)){s.writeHead(403);return s.end();}
  fs.stat(fp,(e,st)=>{
    if(e||!st.isFile()){s.writeHead(404);return s.end('404');}
    const type=T[path.extname(fp).toLowerCase()]||'application/octet-stream';
    const range=q.headers.range;
    if(range){
      const m=/bytes=(\d*)-(\d*)/.exec(range)||[];
      const start=m[1]?parseInt(m[1]):0, end=m[2]?parseInt(m[2]):st.size-1;
      if(start>=st.size){s.writeHead(416,{'Content-Range':`bytes */${st.size}`});return s.end();}
      s.writeHead(206,{'Content-Type':type,'Content-Range':`bytes ${start}-${end}/${st.size}`,
        'Accept-Ranges':'bytes','Content-Length':end-start+1});
      fs.createReadStream(fp,{start,end}).pipe(s);
    } else {
      s.writeHead(200,{'Content-Type':type,'Content-Length':st.size,'Accept-Ranges':'bytes'});
      fs.createReadStream(fp).pipe(s);
    }
  });
}).listen(PORT,'127.0.0.1',()=>console.log('web on',PORT));
```

## 3. Restart both services
```
sudo systemctl restart deskbuddy-api deskbuddy-web
```

## 4. Verify (all must pass)
```
curl -sI https://deskbuddy.yuvexel.com | head -1                     # 200, home page
curl -sI https://deskbuddy.yuvexel.com/docs.html | head -1           # 200
curl -sI https://deskbuddy.yuvexel.com/support.html | head -1        # 200
curl -sI https://deskbuddy.yuvexel.com/media/gojo-hero.mp4 | head -3 # 200 + Content-Type: video/mp4
curl -s -X POST https://api.yuvexel.com/api/feedback -H "Content-Type: application/json" \
  -d '{"kind":"bug","message":"handoff deploy test"}'                # {"ok":true}
curl -s -X POST https://api.yuvexel.com/api/waitlist -H "Content-Type: application/json" \
  -d '{"email":"deploy-test@example.com"}'                           # {"ok":true}
```
Also open https://deskbuddy.yuvexel.com in a browser: the home hero should play a looping
video, the gallery should show clips, and docs/support/blog/about/download should all load.

## What this deploy contains
- Full multi-page site: home (video hero + real captures), download, docs (directory
  sidebar), FAQ & support (forms → the new `POST /api/feedback`), blog, about.
- New API endpoint `POST /api/feedback` → appends to `/var/lib/deskbuddy/feedback.json`
  (bug reports + questions from the site; the owner reviews that file — same for
  `waitlist.json`).

## Report back
Print PASS/FAIL for each verify line and the final live URLs.
