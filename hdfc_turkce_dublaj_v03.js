
/*
 * HD Film Cehennemi - Lampa Turkish Dub (MVP 0.3.0)
 * Context-menu integration + cautious film matching + direct media discovery.
 * The site's HTML/search URL and embedded player are NOT verified end-to-end.
 * Does not solve third-party iframe providers, CORS/403 or DRM.
 */
(function () {
  'use strict';
  var NS = 'hdfc_dub_v03';
  if (window[NS]) return;
  window[NS] = true;

  var BASE = 'https://www.hdfilmcehennemi.nl';
  var MAX_RESULTS = 12;
  var CURRENT = 0;
  var activeNetwork = null;
  var DEBUG = !!window.hdfc_dub_debug;

  function log() {
    if (DEBUG && window.console && console.log)
      console.log.apply(console, ['[HDFC Dub]'].concat([].slice.call(arguments)));
  }

  function notify(message) {
    if (window.Lampa && Lampa.Noty && Lampa.Noty.show)
      Lampa.Noty.show('HDFC: ' + message);
    else log(message);
  }

  function cleanSpace(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  function cleanTitle(s) {
    return cleanSpace(s)
      .replace(/\((?:19|20)\d{2}\)/g, ' ')
      .replace(/\b(?:19|20)\d{2}\b/g, ' ')
      .replace(/\b(?:türkçe|turkce)\s*(?:dublaj|altyazılı|altyazili)\b/gi, ' ')
      .replace(/\bdublaj\s*(?:&|ve|\+)\s*altyaz[ıi]l[ıi]\b/gi, ' ')
      .replace(/\b(?:filmini izle|film izle|hd izle|1080p|720p|4k)\b/gi, ' ')
      .replace(/\s+(?:izle|filmi)\s*$/i, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  function norm(s) {
    var result = cleanTitle(s).toLocaleLowerCase
      ? cleanTitle(s).toLocaleLowerCase('tr')
      : cleanTitle(s).toLowerCase();

    result = result.replace(/ı/g, 'i')
      .replace(/ş/g, 's')
      .replace(/ğ/g, 'g')
      .replace(/ç/g, 'c')
      .replace(/ö/g, 'o')
      .replace(/ü/g, 'u');

    if (result.normalize)
      result = result.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    return cleanSpace(result.replace(/[^a-z0-9]+/g, ' '))
      .replace(/^(the|a|an)\s+/, '');
  }

  function hasDub(s) {
    return /(?:t[uü]rk[cç]e?\s*dublaj|tr\s*dublaj|t[uü]rk[cç]e?\s*seslendirme|dublaj\s*(?:&|ve|\+)\s*altyaz[ıi]l[ıi]|\bdu[bp]laj\b)/i.test(String(s || ''));
  }

  function hasSub(s) {
    return /(?:altyaz[ıi]l[ıi]|alt\s*yaz[ıi]|\bsubbed\b|\bsubtitles?\b)/i.test(String(s || ''));
  }

  function sourceLanguage(label) {
    var s = cleanSpace(label);
    if (!s) return 'unknown';

    if (/\b(?:tur|tr)\b/i.test(s) && !hasSub(s))
      return 'dub';

    if (hasDub(s) && !hasSub(s))
      return 'dub';

    if (hasSub(s) && !hasDub(s))
      return 'sub';

    if (hasSub(s) && hasDub(s))
      return 'ambiguous';

    return 'unknown';
  }

  function filmYear(movie) {
    var x = movie && (
      movie.release_date ||
      movie.first_air_date ||
      movie.year ||
      movie.start_date ||
      ''
    );

    var match = String(x).match(/\b(?:19|20)\d{2}\b/);
    return match ? Number(match[0]) : 0;
  }

  function aliases(movie) {
    var list = [
      movie.original_title,
      movie.title,
      movie.original_name,
      movie.name,
      movie.international_title
    ];

    var seen = {};

    return list.map(cleanTitle).filter(function (s) {
      var n = norm(s);
      if (n.length < 3 || seen[n]) return false;
      seen[n] = true;
      return true;
    });
  }

  function splitNames(s) {
    var cleaned = cleanTitle(s);

    return [cleaned]
      .concat(cleaned.split(/\s+[-–—]\s+|\s+[\/]\s+/))
      .filter(Boolean);
  }

  function titleScore(candidate, variants, targetYear, foundYear) {
    if (targetYear && foundYear && targetYear !== foundYear)
      return -1;

    var best = 0;

    splitNames(candidate).forEach(function (part) {
      var a = norm(part);
      if (!a) return;

      variants.forEach(function (name) {
        var b = norm(name);
        if (!b) return;

        if (a === b) {
          best = Math.max(best, 100);
          return;
        }

        if (
          a.length >= 9 &&
          b.length >= 9 &&
          (a.indexOf(b) !== -1 || b.indexOf(a) !== -1)
        ) {
          var ratio = Math.min(a.length, b.length) /
            Math.max(a.length, b.length);

          if (ratio >= 0.86)
            best = Math.max(best, 88);
        }
      });
    });

    return best;
  }

  function urlFrom(raw, origin) {
    if (!raw || /^\s*(?:javascript:|data:|blob:)/i.test(raw))
      return '';

    try {
      var u = new URL(raw, origin);
      return (u.protocol === 'http:' || u.protocol === 'https:')
        ? u.href
        : '';
    } catch (e) {
      return '';
    }
  }

  function isSiteLink(link) {
    try {
      var u = new URL(link);

      return (
        u.hostname === 'hdfilmcehennemi.nl' ||
        u.hostname === 'www.hdfilmcehennemi.nl'
      ) &&
        !/(?:\/category\/|\/dil\/|\/tur\/|\/yil\/|\/page\/|\/tag\/|\/author\/|\/search\/)/i.test(u.pathname) &&
        u.pathname !== '/' &&
        !u.searchParams.has('s');
    } catch (e) {
      return false;
    }
  }

  function mediaUrl(u) {
    return /\.(?:m3u8|mp4|mpd)(?:[?#]|$)/i.test(u || '');
  }

  function parseHTML(text) {
    if (typeof text !== 'string')
      throw new Error('Response is not HTML text');

    if (!/<(?:html|body|article|div|video|source|a)\b/i.test(text))
      throw new Error('Unexpected page response');

    return new DOMParser().parseFromString(text, 'text/html');
  }

  function attr(node, name) {
    return node && node.getAttribute
      ? (node.getAttribute(name) || '')
      : '';
  }

  function findOne(node, selectors) {
    return node && node.querySelector
      ? node.querySelector(selectors)
      : null;
  }

  function findAll(node, selectors) {
    return node && node.querySelectorAll
      ? [].slice.call(node.querySelectorAll(selectors))
      : [];
  }

  function extractLabel(card) {
    var titleNode = findOne(
      card,
      '.movie-title, .film-title, .title, h2, h3, h4, a[title], img[alt]'
    );

    var title = titleNode
      ? (
        attr(titleNode, 'title') ||
        attr(titleNode, 'alt') ||
        titleNode.textContent
      )
      : '';

    if (!title)
      title = attr(card, 'title');

    if (!title) {
      var a = findOne(card, 'a[href]');
      title = a && (
        attr(a, 'title') ||
        (a.textContent || '')
      );
    }

    return cleanSpace(title);
  }

  function yearInCard(card, rawTitle) {
    var y = findOne(
      card,
      '[data-year], .year, .yil, time[datetime], .date'
    );

    var text = (
      y && (
        attr(y, 'data-year') ||
        attr(y, 'datetime') ||
        y.textContent
      )
    ) || String(rawTitle || '');

    var match = String(text).match(/\b(?:19|20)\d{2}\b/);
    return match ? Number(match[0]) : 0;
  }

  function parseSearchResults(html, pageUrl, names, year) {
    var doc = parseHTML(html);
    var output = [];
    var seen = {};

    var cards = findAll(
      doc,
      'article, .movie-item, .film-item, .filmbox, .post, .film, .movie, .item'
    );

    cards.forEach(function (card) {
      var link = findOne(
        card,
        'h2 a[href], h3 a[href], h4 a[href], .title a[href], a[href]'
      );

      if (!link) return;

      var url = urlFrom(attr(link, 'href'), pageUrl);

      if (!url || !isSiteLink(url) || seen[url])
        return;

      var title =
        extractLabel(card) ||
        attr(link, 'title') ||
        cleanSpace(link.textContent);

      var y = yearInCard(card, title);
      var score = titleScore(title, names, year, y);

      if (score < 88 || !hasDub(card.textContent || ''))
        return;

      seen[url] = true;

      output.push({
        title: title,
        year: y,
        url: url,
        score: score,
        dubbed: true
      });
    });

    return output
      .sort(function (a, b) {
        return b.score - a.score;
      })
      .slice(0, MAX_RESULTS);
  }

  function playerSourceLabel(el) {
    var text = [
      attr(el, 'label'),
      attr(el, 'title'),
      attr(el, 'data-audio'),
      attr(el, 'data-language'),
      attr(el, 'lang')
    ];

    if (
      el.tagName &&
      el.tagName.toLowerCase() === 'a'
    ) {
      text.push(el.textContent || '');
    }

    var scope = el.closest && el.closest(
      '[data-audio], [data-language], [data-lang], .tab-pane, .source-item, .video-source'
    );

    if (scope) {
      text.push(
        attr(scope, 'data-audio'),
        attr(scope, 'data-language'),
        attr(scope, 'data-lang'),
        attr(scope, 'title')
      );
    }

    return cleanSpace(text.join(' '));
  }

  function parseDirectStreams(html, url, cardDubbed) {
    var doc = parseHTML(html);
    var out = [];
    var seen = {};

    var pageText = doc.body
      ? cleanSpace(doc.body.textContent)
      : '';

    var pageDubbed = hasDub(pageText);
    var pageHasSub = hasSub(pageText);

    var pageIsDubOnly =
      (pageDubbed || cardDubbed) && !pageHasSub;

    var pageExplicitSubOnly =
      pageHasSub && !pageDubbed;

    var iframeCount = findAll(
      doc,
      'iframe[src], iframe[data-src]'
    ).length;

    if (pageExplicitSubOnly) {
      return {
        streams: [],
        iframeCount: iframeCount,
        reason: 'sub_only'
      };
    }

    findAll(
      doc,
      'video[src], video source[src], source[src], a[href]'
    ).forEach(function (el) {
      var path = attr(el, 'src') || attr(el, 'href');
      var direct = urlFrom(path, url);

      if (
        !direct ||
        !mediaUrl(direct) ||
        seen[direct]
      ) return;

      var language = sourceLanguage(
        playerSourceLabel(el)
      );

      if (
        language === 'sub' ||
        language === 'ambiguous'
      ) return;

      if (
        language === 'unknown' &&
        !pageIsDubOnly
      ) return;

      seen[direct] = true;

      out.push({
        url: direct,
        title: cleanSpace(
          attr(el, 'label') ||
          attr(el, 'title')
        ) || 'Türkçe Dublaj',
        language: 'tr'
      });
    });

    return {
      streams: out,
      iframeCount: iframeCount,
      reason: out.length
        ? ''
        : (iframeCount ? 'iframe' : 'no_direct_stream')
    };
  }

  function stopPrevious() {
    CURRENT++;

    if (
      activeNetwork &&
      activeNetwork.clear
    ) {
      try {
        activeNetwork.clear();
      } catch (e) {
        log(e);
      }
    }

    activeNetwork = null;
    return CURRENT;
  }

  function requestHTML(url, token, done) {
    if (token !== CURRENT) return;

    if (!activeNetwork)
      activeNetwork = new Lampa.Reguest();

    try {
      activeNetwork.native(
        url,
        function (result) {
          if (token === CURRENT)
            done(null, result);
        },
        function (xhr, error) {
          if (token === CURRENT) {
            done(
              new Error(
                'HTTP/CORS error: ' +
                ((xhr && xhr.status) || '') +
                ' ' +
                (error || '')
              )
            );
          }
        },
        null,
        {
          dataType: 'text',
          timeout: 15000
        }
      );
    } catch (e) {
      if (token === CURRENT)
        done(e);
    }
  }

  function selectList(items, title, choose) {
    if (!items.length) {
      notify('Uyğun nəticə tapılmadı');
      return;
    }

    Lampa.Select.show({
      title: title,
      items: items.map(function (x) {
        return {
          title: cleanSpace(x.title),
          subtitle: (
            x.year ? x.year + ' · ' : ''
          ) + 'Türkçe Dublaj',
          payload: x
        };
      }),
      onSelect: function (item) {
        choose(item.payload);
      },
      onBack: function () {
        if (
          Lampa.Controller &&
          Lampa.Controller.toggle
        ) {
          Lampa.Controller.toggle('content');
        }
      }
    });
  }

  function openFilm(movie, item, token) {
    notify('Video mənbəyi yoxlanılır');

    requestHTML(item.url, token, function (error, html) {
      if (error) {
        log(error);
        notify('Film səhifəsi açıla bilmədi (403/CORS və ya şəbəkə)');
        return;
      }

      var found;

      try {
        found = parseDirectStreams(
          html,
          item.url,
          item.dubbed
        );
      } catch (e) {
        log(e);
        notify('Film səhifəsinin formatı tanınmadı');
        return;
      }

      log(
        'direct-streams',
        found.streams.length,
        'iframes',
        found.iframeCount
      );

      if (!found.streams.length) {
        if (found.reason === 'sub_only') {
          notify('Bu səhifədə yalnız altyazı işarəsi var');
        } else if (found.reason === 'iframe') {
          notify('Dublaj var, amma video iframe-dədir; ayrıca resolver lazımdır');
        } else {
          notify('Türk dublyajlı birbaşa video linki təsdiqlənmədi');
        }
        return;
      }

      selectList(
        found.streams,
        'HDFC - Türkçe Dublaj',
        function (stream) {
          Lampa.Player.play({
            url: stream.url,
            title: (
              movie.title ||
              movie.original_title ||
              item.title
            ),
            movie: movie,
            isonline: true
          });
        }
      );
    });
  }

  function startSearch(movie) {
    if (!movie) {
      notify('Film məlumatı boşdur');
      return;
    }

    if (
      movie.media_type === 'tv' ||
      movie.number_of_seasons ||
      movie.first_air_date
    ) {
      notify('Bu MVP yalnız filmlər üçündür; seriallar ayrıca modul tələb edir');
      return;
    }

    var names = aliases(movie);
    var year = filmYear(movie);

    if (!names.length) {
      notify('Film adı yoxdur');
      return;
    }

    var token = stopPrevious();
    var found = {};
    var errors = 0;
    var index = 0;

    notify(
      'Axtarılır: ' +
      names[0] +
      (year ? ' (' + year + ')' : '')
    );

    function next() {
      if (token !== CURRENT) return;

      if (index >= names.length) {
        var output = Object.keys(found)
          .map(function (key) {
            return found[key];
          })
          .sort(function (a, b) {
            return b.score - a.score;
          })
          .slice(0, MAX_RESULTS);

        if (!output.length) {
          notify(
            errors === names.length
              ? 'Sayta giriş bloklandı (CORS/403)'
              : 'Film və türk dublyaj uyğunluğu tapılmadı'
          );
          return;
        }

        selectList(
          output,
          'HDFC - Türkçe Dublaj',
          function (item) {
            openFilm(movie, item, token);
          }
        );
        return;
      }

      var searchName = names[index++];

      var searchLink =
        BASE + '/?s=' +
        encodeURIComponent(searchName);

      requestHTML(
        searchLink,
        token,
        function (err, page) {
          if (err) {
            errors++;
            log('search failed', searchName, err);
            next();
            return;
          }

          try {
            var list = parseSearchResults(
              page,
              searchLink,
              names,
              year
            );

            list.forEach(function (item) {
              if (
                !found[item.url] ||
                item.score > found[item.url].score
              ) {
                found[item.url] = item;
              }
            });

            log('results', searchName, list.length);
          } catch (e) {
            errors++;
            log('parser failed', searchName, e);
          }

          next();
        }
      );
    }

    next();
  }

  function register() {
    if (
      !window.Lampa ||
      !Lampa.Manifest ||
      !Lampa.Reguest ||
      !Lampa.Select ||
      !Lampa.Player
    ) {
      log('Lampa required APIs missing');
      return;
    }

    Lampa.Manifest.plugins = {
      type: 'video',
      version: '0.3.0',
      name: 'HDFC Türkçe Dublaj',
      description:
        'HDFC: film adına/ilinə görə axtarış, yalnız Türkçe Dublaj, direct media MVP',
      component: 'hdfc_dub_v03',

      onContextMenu: function () {
        return {
          name: 'HDFC Türkçe Dublaj',
          description: 'Film üzrə axtarış (MVP)'
        };
      },

      onContextLauch: function (movie) {
        startSearch(movie);
      }
    };

    log('registered v0.3.0');
  }

  if (window.__HDFC_TEST_MODE__) {
    window.__HDFC_TEST_UTILS__ = {
      norm: norm,
      hasDub: hasDub,
      hasSub: hasSub,
      sourceLanguage: sourceLanguage,
      titleScore: titleScore,
      aliases: aliases,
      filmYear: filmYear,
      parseSearchResults: parseSearchResults,
      parseDirectStreams: parseDirectStreams
    };
  }

  if (window.Lampa) {
    if (window.appready) {
      register();
    } else if (
      Lampa.Listener &&
      Lampa.Listener.follow
    ) {
      Lampa.Listener.follow('app', function (e) {
        if (e.type === 'ready')
          register();
      });
    }
  }
})();
