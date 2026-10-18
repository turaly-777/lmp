
/*
 * HDFC Turkish Dub for Lampa
 * Version: 0.4.0
 *
 * Film card -> Turkish Dub button -> Search -> Stream
 *
 * Important:
 * Site search markup and video hosts are not yet verified.
 * No CORS bypass or iframe resolver is included.
 */

(function () {
  'use strict';

  var KEY = '__hdfc_turkish_dub_v04';
  if (window[KEY]) return;
  window[KEY] = true;

  var BASE = 'https://www.hdfilmcehennemi.nl';
  var DEBUG = true;
  var LIMIT = 10;
  var network = null;
  var generation = 0;
  var registered = false;

  function log() {
    if (!DEBUG || !window.console) return;
    var args = ['[HDFC v0.4]'].concat(
      Array.prototype.slice.call(arguments)
    );
    console.log.apply(console, args);
  }

  function message(text) {
    log(text);
    if (window.Lampa && Lampa.Noty) {
      Lampa.Noty.show('HDFC: ' + text);
    }
  }

  function str(value) {
    return String(value == null ? '' : value)
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalize(value) {
    var s = str(value)
      .toLowerCase()
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
      .replace(/\b(19|20)\d{2}\b/g, ' ')
      .replace(/\b(turkce|dublaj|altyazili|izle|hd|film)\b/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function yearOf(value) {
    var match = str(value).match(/\b(?:19|20)\d{2}\b/);
    return match ? Number(match[0]) : 0;
  }

  function movieYear(movie) {
    return yearOf(
      movie.release_date ||
      movie.first_air_date ||
      movie.year ||
      ''
    );
  }

  function isSeries(movie) {
    return movie.media_type === 'tv' ||
      !!movie.first_air_date ||
      !!movie.number_of_seasons;
  }

  function namesOf(movie) {
    var items = [
      movie.original_title,
      movie.title,
      movie.original_name,
      movie.name
    ];

    var alternative = movie.alternative_titles || {};
    var extra = alternative.titles || alternative.results || [];

    if (Array.isArray(extra)) {
      extra.forEach(function (item) {
        if (item && item.title) {
          items.push(item.title);
        }
      });
    }

    var seen = {};
    return items.filter(function (item) {
      var n = normalize(item);
      if (n.length < 3 || seen[n]) return false;
      seen[n] = true;
      return true;
    }).slice(0, 8);
  }

  function isDub(text) {
    var s = str(text).toLowerCase();

    return /t[uü]rk[cç]e\s*dublaj|t[uü]rk[cç]e\s*seslendirme|\btr\s*dublaj\b|\bdublaj\b|\bdubbed\b/.test(s);
  }

  function isSubtitle(text) {
    return /altyaz[ıi]|alt\s*yaz[ıi]|\bsubbed\b|\bsubtitle\b/i
      .test(str(text));
  }

  function dubStatus(text) {
    var dub = isDub(text);
    var sub = isSubtitle(text);

    if (dub && sub) return 'mixed';
    if (dub) return 'dub';
    if (sub) return 'sub';

    return 'unknown';
  }

  function safeUrl(value, base) {
    try {
      var url = new URL(value, base);

      if (url.protocol !== 'http:' &&
          url.protocol !== 'https:') {
        return '';
      }

      return url.href;
    } catch (error) {
      return '';
    }
  }

  function sameSite(url) {
    try {
      var host = new URL(url).hostname.toLowerCase();

      return host === 'hdfilmcehennemi.nl' ||
        host === 'www.hdfilmcehennemi.nl';
    } catch (error) {
      return false;
    }
  }

  function isFilmPage(url) {
    if (!sameSite(url)) return false;

    var u = new URL(url);

    if (u.pathname === '/') return false;
    if (u.searchParams.has('s')) return false;

    return !/^\/(category|tag|page|author|search|tur|yil|dil)\//i
      .test(u.pathname);
  }

  function parseDocument(html) {
    if (typeof html !== 'string') {
      throw new Error('HTML cavabi metn deyil');
    }

    if (!/<(?:html|body|div|article|a)\b/i.test(html)) {
      throw new Error('HTML formati taninmadi');
    }

    return new DOMParser()
      .parseFromString(html, 'text/html');
  }

  function pickText(element, selector) {
    var selected = element.querySelector(selector);
    return selected ? str(selected.textContent) : '';
  }

  function scoreTitle(candidate, names, targetYear, actualYear) {
    if (targetYear && actualYear &&
        targetYear !== actualYear) {
      return -1;
    }

    var actual = normalize(candidate);
    if (!actual) return 0;

    var best = 0;

    names.forEach(function (name) {
      var expected = normalize(name);
      if (!expected) return;

      if (actual === expected) {
        best = Math.max(best, 100);
      } else if (
        expected.length >= 8 &&
        actual.length >= 8 &&
        (actual.indexOf(expected) !== -1 ||
         expected.indexOf(actual) !== -1)
      ) {
        var ratio = Math.min(
          actual.length,
          expected.length
        ) / Math.max(actual.length, expected.length);

        if (ratio >= 0.85) {
          best = Math.max(best, 85);
        }
      }
    });

    return best;
  }

  function searchResults(html, url, names, year) {
    var documentNode = parseDocument(html);
    var cards = documentNode.querySelectorAll(
      'article, .movie-item, .film-item, ' +
      '.filmbox, .post, .movie, .film'
    );

    var output = [];
    var seen = {};

    Array.prototype.forEach.call(cards, function (card) {
      var anchor = card.querySelector(
        'h2 a[href], h3 a[href], ' +
        '.title a[href], a[href]'
      );

      if (!anchor) return;

      var link = safeUrl(
        anchor.getAttribute('href'),
        url
      );

      if (!link || !isFilmPage(link) || seen[link]) {
        return;
      }

      var title = pickText(
        card,
        'h2, h3, .movie-title, .film-title, .title'
      );

      if (!title) {
        title = str(
          anchor.getAttribute('title') ||
          anchor.textContent
        );
      }

      var yearNode = card.querySelector(
        '[data-year], .year, .yil, time[datetime]'
      );

      var actualYear = yearNode
        ? yearOf(
            yearNode.getAttribute('data-year') ||
            yearNode.getAttribute('datetime') ||
            yearNode.textContent
          )
        : yearOf(title);

      var score = scoreTitle(
        title,
        names,
        year,
        actualYear
      );

      if (score < 85) return;

      // This is a candidate, not yet a playable film.
      // Final dubbing confirmation happens on film page.
      var status = dubStatus(card.textContent);

      if (status === 'sub') return;

      seen[link] = true;

      output.push({
        title: title,
        url: link,
        year: actualYear,
        score: score,
        dubStatus: status
      });
    });

    return output.sort(function (a, b) {
      return b.score - a.score;
    }).slice(0, LIMIT);
  }

  function mediaUrl(url) {
    return /\.(mp4|m3u8|mpd)(?:$|[?#])/i.test(url);
  }

  function streamLanguage(element) {
    var texts = [
      element.getAttribute('data-audio'),
      element.getAttribute('data-language'),
      element.getAttribute('data-lang'),
      element.getAttribute('lang'),
      element.getAttribute('label'),
      element.getAttribute('title')
    ];

    var parent = element.closest(
      '[data-audio], [data-language], ' +
      '[data-lang], .video-source, .source-item'
    );

    if (parent) {
      texts.push(
        parent.getAttribute('data-audio'),
        parent.getAttribute('data-language'),
        parent.getAttribute('data-lang'),
        parent.getAttribute('title')
      );
    }

    if (element.tagName.toLowerCase() === 'a') {
      texts.push(element.textContent);
    }

    var explicitLang = str(texts.join(' '));

    return dubStatus(explicitLang);
  }

  function streamsFromFilm(html, pageUrl, candidate) {
    var doc = parseDocument(html);

    var out = [];
    var seen = {};

    var iframeCount = doc.querySelectorAll(
      'iframe[src], iframe[data-src]'
    ).length;

    // Metadata may contain both dubbing and subtitles.
    // That alone cannot identify an individual audio track.
    var metadata = doc.querySelector(
      '.film-info, .movie-info, .post-info, ' +
      '.entry-meta, .film-detail, .language'
    );

    var metadataStatus = dubStatus(
      metadata ? metadata.textContent : ''
    );

    if (metadataStatus === 'unknown') {
      metadataStatus = candidate.dubStatus;
    }

    var elements = doc.querySelectorAll(
      'video[src], video source[src], source[src], a[href]'
    );

    Array.prototype.forEach.call(elements, function (el) {
      var raw = el.getAttribute('src') ||
        el.getAttribute('href');

      var url = safeUrl(raw, pageUrl);

      if (!url || !mediaUrl(url) || seen[url]) {
        return;
      }

      var audio = streamLanguage(el);

      // Only a positively identified dubbing source.
      // When the whole film has a dub-only label,
      // an unlabelled single direct stream may be used.
      var allowed = audio === 'dub' ||
        (
          audio === 'unknown' &&
          metadataStatus === 'dub'
        );

      if (!allowed) return;

      seen[url] = true;
      out.push({
        url: url,
        title: 'Türkçe Dublaj',
        quality: 'auto'
      });
    });

    return {
      streams: out,
      iframeCount: iframeCount,
      metadataStatus: metadataStatus
    };
  }

  function abortRequests() {
    generation++;

    if (network) {
      try {
        network.clear();
      } catch (error) {
        log('clear error', error);
      }
    }

    network = null;
    return generation;
  }

  function request(url, token, callback) {
    if (token !== generation) return;

    var instance = new Lampa.Reguest();
    network = instance;

    log('GET', url);

    try {
      instance.silent(
        url,
        function (response) {
          if (token !== generation) return;
          callback(null, response);
        },
        function (error) {
          if (token !== generation) return;
          callback(
            new Error('Request failed: ' + str(error))
          );
        },
        false,
        {
          dataType: 'text',
          timeout: 15000
        }
      );
    } catch (error) {
      if (token === generation) {
        callback(error);
      }
    }
  }

  function showItems(title, list, onSelect) {
    if (!list.length) {
      message('Uyğun nəticə tapılmadı');
      return;
    }

    Lampa.Select.show({
      title: title,
      items: list.map(function (item) {
        return {
          title: item.title,
          subtitle: (
            item.year ? item.year + ' · ' : ''
          ) + (
            item.dubStatus === 'dub'
              ? 'Türkçe Dublaj'
              : 'Dublaj yoxlanılacaq'
          ),
          data: item
        };
      }),
      onSelect: function (selected) {
        if (selected && selected.data) {
          onSelect(selected.data);
        }
      },
      onBack: function () {
        Lampa.Controller.toggle('content');
      }
    });
  }

  function playStream(movie, stream) {
    log('Playing', stream.url);

    Lampa.Player.play({
      url: stream.url,
      title: movie.title || movie.original_title,
      movie: movie,
      isonline: true,
      quality: stream.quality || 'auto'
    });
  }

  function openCandidate(movie, candidate, token) {
    message('Film səhifəsi yoxlanılır');

    request(candidate.url, token, function (error, html) {
      if (error) {
        log(error);
        message('Film səhifəsi açılmadı: HTTP/CORS xətası');
        return;
      }

      var result;

      try {
        result = streamsFromFilm(
          html,
          candidate.url,
          candidate
        );
      } catch (parseError) {
        log(parseError);
        message('Film HTML formatı tanınmadı');
        return;
      }

      if (!result.streams.length) {
        if (result.iframeCount > 0) {
          message(
            'Video iframe içindədir. ' +
            'Bu sayt üçün ayrıca resolver lazımdır.'
          );
        } else {
          message(
            'Təsdiqlənmiş Türkçe Dublaj ' +
            'video bağlantısı tapılmadı'
          );
        }
        return;
      }

      if (result.streams.length === 1) {
        playStream(movie, result.streams[0]);
        return;
      }

      showItems(
        'Türkçe Dublaj — Video',
        result.streams,
        function (stream) {
          playStream(movie, stream);
        }
      );
    });
  }

  function startSearch(movie) {
    if (!movie) {
      message('Film məlumatları alınmadı');
      return;
    }

    if (isSeries(movie)) {
      message('Bu versiya yalnız filmlər üçündür');
      return;
    }

    var names = namesOf(movie);
    var year = movieYear(movie);

    if (!names.length) {
      message('Film adı tapılmadı');
      return;
    }

    var token = abortRequests();
    var candidates = {};
    var index = 0;
    var errors = 0;

    message(
      'Axtarılır: ' + names[0] +
      (year ? ' (' + year + ')' : '')
    );

    function next() {
      if (token !== generation) return;

      if (index >= names.length) {
        var results = Object.keys(candidates)
          .map(function (key) {
            return candidates[key];
          })
          .sort(function (a, b) {
            return b.score - a.score;
          })
          .slice(0, LIMIT);

        if (!results.length) {
          message(
            errors === names.length
              ? 'Sayta giriş mümkün olmadı (HTTP/CORS)'
              : 'Uyğun film tapılmadı'
          );
          return;
        }

        showItems(
          'HDFC — Film seçimi',
          results,
          function (item) {
            openCandidate(movie, item, token);
          }
        );
        return;
      }

      var name = names[index++];
      var searchUrl = BASE + '/?s=' +
        encodeURIComponent(name);

      request(searchUrl, token, function (error, html) {
        if (error) {
          errors++;
          log('Search error', error);
          next();
          return;
        }

        try {
          var matches = searchResults(
            html,
            searchUrl,
            names,
            year
          );

          matches.forEach(function (item) {
            if (
              !candidates[item.url] ||
              item.score > candidates[item.url].score
            ) {
              candidates[item.url] = item;
            }
          });

          log(name, matches.length, 'candidate(s)');
        } catch (parseError) {
          errors++;
          log('Search parse error', parseError);
        }

        next();
      });
    }

    next();
  }

  function addButton(event) {
    try {
      if (!event || !event.object ||
          !event.object.activity) return;

      var root = event.object.activity.render();
      if (!root || !root.find) return;

      if (root.find('.view--hdfc-dub').length) {
        return;
      }

      var movie = event.data && event.data.movie;

      if (!movie) {
        log('No movie in full event');
        return;
      }

      if (isSeries(movie)) return;

      var box = root.find(
        '.full-start-new__buttons, .full-start__buttons'
      ).eq(0);

      if (!box.length) {
        box = root.find('.view--torrent').parent();
      }

      if (!box.length) {
        log('Full page button container not found');
        return;
      }

      var button = $(
        '<div class="full-start__button selector view--hdfc-dub">' +
          '<svg width="24" height="24" ' +
            'viewBox="0 0 24 24">' +
            '<path fill="currentColor" ' +
              'd="M8 5v14l11-7z"/>' +
          '</svg>' +
          '<span>Türkçe Dublaj</span>' +
        '</div>'
      );

      button.on('hover:enter', function () {
        log('Selected movie', movie);
        startSearch(movie);
      });

      box.append(button);

      log(
        'Button added:',
        movie.title || movie.original_title
      );
    } catch (error) {
      console.error('[HDFC] addButton error:', error);
    }
  }

  function register() {
    if (registered) return;

    if (
      !window.Lampa ||
      !Lampa.Listener ||
      !Lampa.Listener.follow ||
      !Lampa.Reguest ||
      !Lampa.Select ||
      !Lampa.Player
    ) {
      log('Waiting for Lampa APIs');
      return;
    }

    registered = true;

    Lampa.Listener.follow('full', function (event) {
      if (event.type === 'complite') {
        addButton(event);
      }
    });

    // Metadata is not used to replace
    // Lampa.Manifest.plugins.
    log('Plugin initialized successfully');
    message('Türkçe Dublaj v0.4 hazırdır');
  }

  if (window.Lampa) {
    if (window.appready) {
      register();
    } else if (
      Lampa.Listener &&
      Lampa.Listener.follow
    ) {
      Lampa.Listener.follow('app', function (event) {
        if (event.type === 'ready') {
          register();
        }
      });
    } else {
      log('Lampa initialization unavailable');
    }
  }
})();
