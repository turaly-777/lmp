
/*
 * FullHDFilmizlesene - Lampa Plugin
 * Version: 0.5.0
 * Turkish Dubbing Only
 *
 * Search:
 *  1. Turkish dub catalog
 *  2. Site search fallback (experimental)
 *
 * Playback:
 *  Direct MP4 / HLS with confirmed Turkish dubbing.
 *
 * CORS, HTTP 403 and embedded video hosts
 * are not bypassed by this plugin.
 */

(function () {
  'use strict';

  var KEY = '__fullhd_lampa_v050';
  if (window[KEY]) return;
  window[KEY] = true;

  var BASE = 'https://www.fullhdfilmizlesene.now';

  var CATALOG =
    BASE + '/filmizle/turkce-dublaj-filmler-1';

  var VERSION = '0.5.0';
  var DEBUG = true;
  var MAX_PAGES = 3;
  var MAX_RESULTS = 10;

  var requestId = 0;
  var activeRequest = null;
  var registered = false;

  function log() {
    if (!DEBUG) return;
    console.log.apply(
      console,
      ['[FULLHD ' + VERSION + ']'].concat(
        Array.prototype.slice.call(arguments)
      )
    );
  }

  function notify(text) {
    log(text);

    if (window.Lampa && Lampa.Noty) {
      Lampa.Noty.show('FullHD: ' + text);
    }
  }

  function text(value) {
    return String(value == null ? '' : value)
      .replace(/\s+/g, ' ')
      .trim();
  }

  function norm(value) {
    var s = text(value).toLowerCase();

    s = s
      .replace(/ı/g, 'i')
      .replace(/ğ/g, 'g')
      .replace(/ü/g, 'u')
      .replace(/ş/g, 's')
      .replace(/ö/g, 'o')
      .replace(/ç/g, 'c');

    if (s.normalize) {
      s = s.normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
    }

    return s
      .replace(/\b(?:19|20)\d{2}\b/g, ' ')
      .replace(/\b(turkce|dublaj|altyazili|izle)\b/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function year(value) {
    var m = text(value).match(/\b(?:19|20)\d{2}\b/);
    return m ? Number(m[0]) : 0;
  }

  function movieYear(movie) {
    return year(
      movie.release_date ||
      movie.year ||
      movie.first_air_date ||
      ''
    );
  }

  function movieNames(movie) {
    var values = [
      movie.original_title,
      movie.title,
      movie.original_name,
      movie.name
    ];

    var seen = {};

    return values.filter(function (name) {
      var n = norm(name);
      if (!n || seen[n]) return false;

      seen[n] = true;
      return n.length >= 3;
    });
  }

  function isSeries(movie) {
    return (
      movie.media_type === 'tv' ||
      !!movie.first_air_date ||
      !!movie.number_of_seasons
    );
  }

  function isDub(value) {
    return /(?:t[uü]rk[cç]e\s*dublaj|\bdublaj\b|\bdubbed\b)/i
      .test(text(value));
  }

  function isSubtitle(value) {
    return /(?:altyaz[ıi]|alt\s*yaz[ıi]|\bsubtitles?\b)/i
      .test(text(value));
  }

  function language(value) {
    var dub = isDub(value);
    var sub = isSubtitle(value);

    if (dub && sub) return 'mixed';
    if (dub) return 'dub';
    if (sub) return 'sub';

    return 'unknown';
  }

  function safeUrl(raw, base) {
    if (!raw) return '';

    try {
      var u = new URL(raw, base);

      return (
        u.protocol === 'http:' ||
        u.protocol === 'https:'
      ) ? u.href : '';
    } catch (e) {
      return '';
    }
  }

  function isFilmUrl(url) {
    try {
      var u = new URL(url);

      var host = u.hostname.toLowerCase();

      var validHost =
        host === 'fullhdfilmizlesene.now' ||
        host === 'www.fullhdfilmizlesene.now';

      return validHost &&
        /^\/film\/[^/]+\/?$/i.test(u.pathname);
    } catch (e) {
      return false;
    }
  }

  function parseHTML(html) {
    if (typeof html !== 'string') {
      throw new Error('Response is not text');
    }

    if (!/<(?:html|body|article|div)\b/i.test(html)) {
      throw new Error('HTML structure not recognized');
    }

    var doc = new DOMParser()
      .parseFromString(html, 'text/html');

    if (
      /just a moment|cf-chl|challenge-platform/i
        .test(doc.title || '')
    ) {
      throw new Error('Anti-bot challenge detected');
    }

    return doc;
  }

  function matchScore(found, names, expectedYear, actualYear) {
    if (
      expectedYear &&
      actualYear &&
      expectedYear !== actualYear
    ) return -1;

    var actual = norm(found);
    var best = 0;

    names.forEach(function (name) {
      var expected = norm(name);

      if (!expected || !actual) return;

      if (actual === expected) {
        best = 100;
        return;
      }

      // Handles "Turkish title - Original title"
      var parts = text(found).split(
        /\s+[-–—]\s+/
      );

      parts.forEach(function (part) {
        if (norm(part) === expected) {
          best = Math.max(best, 100);
        }
      });

      if (
        expected.length >= 8 &&
        actual.indexOf(expected) !== -1
      ) {
        best = Math.max(best, 85);
      }
    });

    return best;
  }

  function parseResults(html, url, names, targetYear) {
    var doc = parseHTML(html);
    var results = [];
    var seen = {};

    var selectors = [
      'article',
      '.movie',
      '.film',
      '.movie-item',
      '.film-item',
      '.film-box',
      '.movie-box',
      '.post',
      '.item'
    ].join(',');

    var cards = doc.querySelectorAll(selectors);

    Array.prototype.forEach.call(cards, function (card) {
      var anchors = card.querySelectorAll(
        'a[href*="/film/"]'
      );

      Array.prototype.forEach.call(
        anchors,
        function (anchor) {
          var link = safeUrl(
            anchor.getAttribute('href'),
            url
          );

          if (!isFilmUrl(link) || seen[link]) return;

          var titleNode = card.querySelector(
            'h2, h3, h4, .title, .film-title, .movie-title'
          );

          var title = text(
            (titleNode && titleNode.textContent) ||
            anchor.getAttribute('title') ||
            anchor.textContent ||
            (anchor.querySelector('img') &&
             anchor.querySelector('img').alt)
          );

          if (!title) return;

          var yrNode = card.querySelector(
            '.year, .yil, [data-year], time'
          );

          var actualYear = yrNode
            ? year(
                yrNode.getAttribute('data-year') ||
                yrNode.getAttribute('datetime') ||
                yrNode.textContent
              )
            : year(card.textContent);

          var score = matchScore(
            title,
            names,
            targetYear,
            actualYear
          );

          if (score < 85) return;

          var status = language(card.textContent);

          // Subtitle-only content is excluded.
          if (status === 'sub') return;

          seen[link] = true;

          results.push({
            title: title,
            url: link,
            year: actualYear,
            score: score,
            dubStatus: status
          });
        }
      );
    });

    return results
      .sort(function (a, b) {
        return b.score - a.score;
      })
      .slice(0, MAX_RESULTS);
  }

  function cancelPrevious() {
    requestId++;

    if (activeRequest) {
      try {
        activeRequest.clear();
      } catch (e) {
        log('Cancel:', e);
      }
    }

    activeRequest = null;
    return requestId;
  }

  function get(url, token, callback) {
    if (token !== requestId) return;

    var req = new Lampa.Reguest();
    activeRequest = req;

    log('REQUEST', url);

    try {
      req.silent(
        url,
        function (body) {
          if (token !== requestId) return;

          callback(null, body);
        },
        function (xhr, status) {
          if (token !== requestId) return;

          var code = xhr && xhr.status
            ? xhr.status
            : 0;

          log('REQUEST ERROR', {
            url: url,
            code: code,
            detail: status,
            xhr: xhr
          });

          callback(
            new Error(
              'Network error, status=' + code
            )
          );
        },
        false,
        {
          dataType: 'text',
          timeout: 15000
        }
      );
    } catch (e) {
      if (token === requestId) callback(e);
    }
  }

  function select(title, list, callback) {
    if (!list.length) {
      notify('Nəticə tapılmadı');
      return;
    }

    Lampa.Select.show({
      title: title,

      items: list.map(function (item) {
        return {
          title: item.title,
          subtitle: item.subtitle ||
            (item.year ? item.year + ' · ' : '') +
            (
              item.dubStatus === 'dub'
                ? 'Türkçe Dublaj'
                : 'Dublaj yoxlanılır'
            ),
          item: item
        };
      }),

      onSelect: function (selected) {
        if (selected && selected.item) {
          callback(selected.item);
        }
      },

      onBack: function () {
        if (Lampa.Controller) {
          Lampa.Controller.toggle('content');
        }
      }
    });
  }

  function mediaUrl(url) {
    return /\.(?:mp4|m3u8|mpd)(?:[?#]|$)/i.test(url);
  }

  function extractStreams(html, pageUrl, candidate) {
    var doc = parseHTML(html);

    var streams = [];
    var seen = {};

    var iframes = doc.querySelectorAll(
      'iframe[src], iframe[data-src]'
    ).length;

    var meta = doc.querySelector(
      '.movie-info, .film-info, .film-detail, ' +
      '.entry-meta, .movie-detail, .language'
    );

    var movieLanguage = language(
      meta ? meta.textContent : ''
    );

    if (movieLanguage === 'unknown') {
      movieLanguage = candidate.dubStatus;
    }

    var nodes = doc.querySelectorAll(
      'video[src], video source[src], source[src], a[href]'
    );

    Array.prototype.forEach.call(nodes, function (node) {
      var url = safeUrl(
        node.getAttribute('src') ||
        node.getAttribute('href'),
        pageUrl
      );

      if (!mediaUrl(url) || seen[url]) return;

      var labels = [
        node.getAttribute('title'),
        node.getAttribute('label'),
        node.getAttribute('lang'),
        node.getAttribute('data-lang'),
        node.getAttribute('data-language'),
        node.getAttribute('data-audio')
      ].join(' ');

      var streamLang = language(labels);

      // Mixed pages are not proof that a stream is dubbed.
      var confirmed = streamLang === 'dub' ||
        (
          streamLang === 'unknown' &&
          movieLanguage === 'dub'
        );

      if (!confirmed) return;

      seen[url] = true;

      streams.push({
        url: url,
        title: 'Türkçe Dublaj',
        subtitle: 'Online Video'
      });
    });

    return {
      streams: streams,
      iframeCount: iframes,
      pageLanguage: movieLanguage
    };
  }

  function play(movie, stream) {
    log('PLAY', stream.url);

    Lampa.Player.play({
      url: stream.url,
      title: movie.title || movie.original_title,
      movie: movie,
      isonline: true
    });
  }

  function openFilm(movie, candidate, token) {
    notify('Film mənbəyi yoxlanılır');

    get(candidate.url, token, function (error, html) {
      if (error) {
        notify('Film səhifəsi açıla bilmədi');
        log(error);
        return;
      }

      var result;

      try {
        result = extractStreams(
          html,
          candidate.url,
          candidate
        );
      } catch (e) {
        notify('Film səhifəsi oxunmadı');
        log(e);
        return;
      }

      if (!result.streams.length) {
        if (result.iframeCount) {
          notify(
            'Video iframe-dədir; ayrıca resolver lazımdır'
          );
        } else {
          notify(
            'Türkçe Dublaj video axını təsdiqlənmədi'
          );
        }
        return;
      }

      if (result.streams.length === 1) {
        play(movie, result.streams[0]);
        return;
      }

      select(
        'Türkçe Dublaj',
        result.streams,
        function (stream) {
          play(movie, stream);
        }
      );
    });
  }

  function startSearch(movie) {
    if (!movie) {
      notify('Film məlumatı yoxdur');
      return;
    }

    if (isSeries(movie)) {
      notify('Bu versiya yalnız filmlər üçündür');
      return;
    }

    var names = movieNames(movie);
    var yr = movieYear(movie);

    if (!names.length) {
      notify('Film adı tapılmadı');
      return;
    }

    var token = cancelPrevious();
    var found = {};
    var step = 0;
    var failures = 0;

    // Verified catalog, plus experimental search fallback.
    var urls = [
      CATALOG,
      CATALOG + '/2',
      CATALOG + '/3'
    ];

    names.forEach(function (name) {
      urls.push(
        BASE + '/?s=' + encodeURIComponent(name)
      );
    });

    notify(
      'Axtarılır: ' + names[0] +
      (yr ? ' (' + yr + ')' : '')
    );

    function next() {
      if (token !== requestId) return;

      if (step >= urls.length) {
        var matches = Object.keys(found)
          .map(function (key) {
            return found[key];
          })
          .sort(function (a, b) {
            return b.score - a.score;
          })
          .slice(0, MAX_RESULTS);

        if (!matches.length) {
          notify(
            failures === urls.length
              ? 'Sayta giriş alınmadı (HTTP/CORS)'
              : 'Uyğun film tapılmadı'
          );
          return;
        }

        select(
          'FullHD - Film seçimi',
          matches,
          function (candidate) {
            openFilm(movie, candidate, token);
          }
        );

        return;
      }

      var url = urls[step++];

      get(url, token, function (error, html) {
        if (error) {
          failures++;
          next();
          return;
        }

        try {
          var results = parseResults(
            html,
            url,
            names,
            yr
          );

          results.forEach(function (item) {
            if (
              !found[item.url] ||
              item.score > found[item.url].score
            ) {
              found[item.url] = item;
            }
          });

          log(
            'SEARCH',
            url,
            'MATCHES',
            results.length
          );

          // Stop early on exact title/year match.
          var exact = results.some(function (item) {
            return item.score === 100 &&
              (!yr || item.year === yr);
          });

          if (exact) {
            step = urls.length;
          }
        } catch (e) {
          failures++;
          log('PARSE ERROR', e);
        }

        next();
      });
    }

    next();
  }

  function addButton(event) {
    if (!event || !event.object ||
        !event.object.activity) return;

    var movie = event.data && event.data.movie;

    if (!movie || isSeries(movie)) return;

    var root = event.object.activity.render();

    if (!root || !root.find) return;

    if (root.find('.view--fullhd-dub').length) {
      return;
    }

    var container = root.find(
      '.full-start-new__buttons, .full-start__buttons'
    ).eq(0);

    if (!container.length) {
      container = root.find(
        '.view--torrent'
      ).parent();
    }

    if (!container.length) {
      log('Button container not found');
      return;
    }

    var button = $(
      '<div class="full-start__button selector view--fullhd-dub">' +
        '<svg width="24" height="24" viewBox="0 0 24 24">' +
          '<path fill="currentColor" d="M8 5v14l11-7z"/>' +
        '</svg>' +
        '<span>FullHD Dublaj</span>' +
      '</div>'
    );

    button.on('hover:enter', function () {
      startSearch(movie);
    });

    container.append(button);

    log('Button added:', movie.title);
  }

  function register() {
    if (registered) return;

    if (
      !window.Lampa ||
      !Lampa.Listener ||
      !Lampa.Reguest ||
      !Lampa.Select ||
      !Lampa.Player
    ) {
      log('Lampa APIs unavailable');
      return;
    }

    registered = true;

    Lampa.Listener.follow('full', function (event) {
      if (event.type === 'complite') {
        addButton(event);
      }
    });

    log('Plugin initialized');
    notify('FullHD Türkçe Dublaj v0.5 hazırdır');
  }

  if (window.Lampa) {
    if (window.appready) {
      register();
    } else if (
      Lampa.Listener &&
      Lampa.Listener.follow
    ) {
      Lampa.Listener.follow('app', function (e) {
        if (e.type === 'ready') register();
      });
    }
  }
})();
