/* ══════════════════════════════════════════════════════════════════
   FORMO — service worker  (build 2026-10-28c)

   Hasta el build 2026-10-03b este archivo no existía en el servidor
   (sw.js daba 404): la app lo registraba, el navegador lo rechazaba
   en silencio y de ahí el "sin caché sin conexión" de Ajustes.

   Qué hace y, sobre todo, qué NO hace:
   · La PÁGINA (index.html) se pide SIEMPRE primero a la red, obligando
     al servidor a confirmar la versión (cache:'no-cache'). Solo si la
     red no contesta en 8 s o falla, se sirve la copia guardada. Así
     nunca se abre una versión vieja habiendo señal — que era la queja
     de "el iPad sigue abriendo la de ayer".
   · El SDK de Firebase (gstatic.com/firebasejs/…) va primero de la
     caché `lib-formo-v1`, que la página misma calienta al arrancar
     (early-1.js) y que el botón "Actualizar" nunca borra.
   · TODO lo demás —Firestore, Storage, Auth, APIs— pasa de largo, sin
     tocarlo: los datos viven en IndexedDB y en la nube, no aquí.
   · La versión nueva NO se impone sola: se queda esperando (waiting)
     hasta que la app, con la barra "Actualizar", manda SKIP_WAITING.
     Nadie pierde una foto a mitad de subida por una recarga sorpresa.

   El build va escrito en este archivo para que cada versión sea un
   service worker distinto byte a byte: así el navegador detecta que
   hay algo nuevo y la app puede avisarlo.
   ══════════════════════════════════════════════════════════════════ */
var BUILD='2026-10-28c';
var APP_CACHE='formo-app-'+BUILD;
var LIB_CACHE='lib-formo-v1';
var ROOT=new URL('./',self.location).href;   // la raíz del sitio, tal cual se pide
var RED_MS=8000;

self.addEventListener('install',function(ev){
  ev.waitUntil(
    caches.open(APP_CACHE).then(function(c){
      /* copia inicial de la página, por si la primera vez sin señal
         llega antes que la primera navegación con este SW activo */
      return fetch(ROOT,{cache:'no-cache'}).then(function(r){
        if(r&&r.ok)return c.put(ROOT,r.clone());
      }).catch(function(){});
    })
  );
  /* sin skipWaiting(): la app decide cuándo aplicar la versión nueva */
});

self.addEventListener('activate',function(ev){
  ev.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){
        return k.indexOf('formo-app-')===0&&k!==APP_CACHE;
      }).map(function(k){return caches.delete(k);}));
    }).then(function(){return self.clients.claim();})
  );
});

self.addEventListener('message',function(ev){
  var d=ev.data||{};
  if(d.type==='SKIP_WAITING')self.skipWaiting();
});

function esPagina(req){
  if(req.mode==='navigate')return true;
  var u=new URL(req.url);
  if(u.origin!==self.location.origin)return false;
  return u.href===ROOT||/\/index\.html$/.test(u.pathname);
}
function esSDK(req){
  return /^https:\/\/www\.gstatic\.com\/firebasejs\//.test(req.url);
}
function conPlazo(p,ms){
  return new Promise(function(ok,no){
    var t=setTimeout(function(){no(new Error('timeout'));},ms);
    p.then(function(v){clearTimeout(t);ok(v);},function(e){clearTimeout(t);no(e);});
  });
}

/* Red primero, caché de respaldo. La respuesta buena se guarda bajo la
   URL pedida y bajo la raíz, para que "/" e "/index.html" compartan copia. */
function pagina(req){
  /* por URL, no con el Request: un Request de navegación no admite
     opciones nuevas (el navegador lanza TypeError) */
  return conPlazo(fetch(req.url,{cache:'no-cache',credentials:'same-origin'}),RED_MS).then(function(r){
    if(r&&r.ok){
      var copia=r.clone();
      caches.open(APP_CACHE).then(function(c){c.put(req,copia.clone());c.put(ROOT,copia);}).catch(function(){});
    }
    return r;
  }).catch(function(){
    return caches.match(req).then(function(hit){
      return hit||caches.match(ROOT);
    }).then(function(hit){
      return hit||new Response('<!doctype html><meta charset="utf-8"><title>Formo</title><p style="font:16px system-ui;padding:24px">Sin conexión y sin copia guardada todavía. Abre la app una vez con señal.</p>',{status:503,headers:{'Content-Type':'text/html; charset=utf-8'}});
    });
  });
}
/* Caché primero: las URLs del SDK llevan la versión, nunca cambian. */
function sdk(req){
  return caches.open(LIB_CACHE).then(function(c){
    return c.match(req.url).then(function(hit){
      if(hit)return hit;
      return fetch(req).then(function(r){
        if(r&&r.ok)c.put(req.url,r.clone()).catch(function(){});
        return r;
      });
    });
  });
}

self.addEventListener('fetch',function(ev){
  var req=ev.request;
  if(req.method!=='GET')return;
  if(esPagina(req)){ev.respondWith(pagina(req));return;}
  if(esSDK(req)){ev.respondWith(sdk(req));return;}
  /* lo demás no se toca */
});
