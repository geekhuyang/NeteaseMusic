import apiList from './apiList';
import Storage from './Storage';
import { getQueryFromUrl } from './stringHelper';
import timer from './timer';
import axios from 'axios';
import idMap from './idMap';

axios.interceptors.response.use(data=> {
//==============  所有请求完成后都要执行的操作  ==================
  if (data.status && data.status == 200 && data.data.status == 'error') {
    return;
  }
  return data;
}, err=> {
  if (!err.config.url) {
    return { code: 500 };
  }
  if (err.config.url.indexOf('/api/playlist/tracks') > -1) {
    if (err.response.data.code === 502) {
      window.VUE_APP.$message.warning('歌曲已存在');
    }
  }
  return Promise.reject(err.response.data);
});

const request = (param) => {
  let obj = param;
  if (typeof param === 'string') {
    obj = { api: param };
  }
  const { method = 'get', api, data = {} } = obj;
  data._t = param.cache ? 0 : new Date().getTime();
  let url =  apiList[api];
  if (method === 'get') {
    url += `?${Object.keys(data).map((k) => `${k}=${data[k]}`).join('&')}`
  }
  return axios({
    method,
    url: '' + url,
    data,
  }).then((res) => {
    if (res.data.code === 200) {
      return res.data;
    } else {
      throw({ data: res.data });
    }
  }, (err) => {
    if (err.msg || err.message) {
      window.VUE_APP.$message.error(err.msg || err.message);
    }
  });
};

// 获取播放列表
export const getPlayList = async (id) => request({ api: 'LIST_DETAIL', data: { id }})
  .then(async (res) => {
    const { playlist } = res;
    const VUE_APP = window.VUE_APP;
    const dispatch = VUE_APP.$store.dispatch;
    const allSongs = VUE_APP.$store.getters.getAllSongs;
    const { tracks } = playlist;
    const ids = [];
    const newSongObj = {};

    // 请求的太多的话返回的会不详细
    const songs = tracks.map((s) => {
      if (!allSongs[s.id]) {
        const { al = {}, ar = [], id, name } = s;
        newSongObj[s.id] = { al, ar: ar.map((a) => a.name).join('/'), id, name, arId: ar.map((a) => a.id).join('/') };
        allSongs[s.id] = newSongObj[s.id];
        ids.push(s.id);
      }
      return s.id;
    });

    // 先显示了，不然可能要等太久了
    dispatch('query163List', { songs, listId: id });
    dispatch('updateAllSongs', newSongObj);

    let urls = [];
    const allIds = [];
    for (let i = 0; i < tracks.length; i++) {
      // 查过的就不查了
      if (allSongs[tracks[i].id].url === undefined) {
        urls.push(tracks[i].id);
      }
      allIds.push(tracks[i].id);
      if ((i > 1 && !(i % 50)) || i === (tracks.length - 1)) {
        if (urls.length) {
          querySongUrl(urls.join(','), i);
        }
        urls = [];
      }
    }

    return res;
  });

// 批量获取歌曲的url
const querySongUrl = (id) => request({
  api: 'SONG_URL',
  data: { id },
  cache: true,
}).then(({ data }) => {
  const VUE_APP = window.VUE_APP;
  const allSongs = VUE_APP.$store.getters.getAllSongs;
  const dispatch = VUE_APP.$store.dispatch;

  const obj = {};
  data.forEach((s) => {
    if (!s.url) {
      const song = allSongs[s.id];
      searchQQ(`${song.name.replace(/\(|\)|（|）/g, ' ')} ${song.ar.replace(/\//g, ' ')}`, s.id);
    }
    if (idMap[s.id]) {
      const { murl, guid, vkey } = Storage.get(['murl', 'guid', 'vkey']);
      obj[s.id] = {
        ...allSongs[s.id],
        br: 128000,
        qqId: idMap[s.id],
        url: `${murl}M500${idMap[id]}.mp3?guid=${guid}&vkey=${vkey}&fromtag=8&uin=0`
      };
    }
    obj[s.id] = { ...allSongs[s.id], br: s.br, url: s.url }
  });
  dispatch('updateAllSongs', obj);
});

// 登陆状态
export const loginStatus = async () => {
  const VUE_APP = window.VUE_APP;
  const dispatch = VUE_APP.$store.dispatch;

  // 查询登陆情况
  const res = await request('LOGIN_STATUS');
  if (!res) {
    // 没有登陆的情况
    request('RECOMMEND_LIST')
      .then(({ result }) => {
        const listObj = {};
        const list = result.map((item) => {
          const { id, name = '', picUrl, trackCount } = item;
          listObj[item.id] = { id, name, trackCount, coverImgUrl: picUrl };
          return listObj[item.id];
        });
        dispatch('setRecommendList', { list, obj: listObj });
        getPlayList(list[0].id)
          .then(({ privileges }) => {
            const allSongs = VUE_APP.$store.getters.getAllSongs;
            // 默认播放
            dispatch('updatePlayNow', allSongs[privileges[0].id]);
            dispatch('updatePlayingList', { list: privileges.map((s) => s.id) });
          })
      });
    return;
  }
  dispatch('setUser', res.profile);
  const uid = res.profile.userId;
  Storage.set('uid', uid);

  // 获取日推
  request('DAILY_RECOMMEND_SONGS')
    .then(({ recommend }) => {
      handleSongs(recommend);
      const songs = recommend.map((item) => item.id);
      dispatch('query163List', { songs, listId: 'daily' });

      const allSongs = VUE_APP.$store.getters.getAllSongs;
      // 默认播放日推
      dispatch('updatePlayNow', allSongs[songs[0]]);
      dispatch('updatePlayingList', { list: songs });
    });

  // 日推歌单
  request('DAILY_RECOMMEND_LIST')
    .then(({ recommend }) => {
      const listObj = {};
      const list = recommend.map((item) => {
        const { id, name = '', picUrl, trackCount } = item;
        listObj[item.id] = { id, name, trackCount, coverImgUrl: picUrl };
        return listObj[item.id];
      });
      dispatch('setRecommendList', { list, obj: listObj });
    });

  // 获取歌单列表
  getMyList(uid, true);
};

// 获取我的歌单列表
export const getMyList = async (uid = Storage.get('uid'), getFav, id) => {
  const { playlist } = await request({ api: 'USER_LIST', data: { uid }});
  const listObj = {};
  const list = playlist.map((item) => {
    const { id, name = '', coverImgUrl, trackCount, subscribed } = item;
    listObj[item.id] = { id, name, trackCount, coverImgUrl, subscribed };
    return listObj[item.id];
  });
  window.VUE_APP.$store.dispatch('setUserList', { list, obj: listObj, favId: list[0].id });

  // 获取我喜欢的歌单
  getFav && getPlayList(playlist[0].id);
  id && getPlayList(id);
};

// 搜索请求
export const searchReq = async ({ keywords, type = 1, pageNo = 1 }) => {
  const VUE_APP = window.VUE_APP;
  const dispatch = VUE_APP.$store.dispatch;

  if (!keywords) {
    return dispatch('updateSearch', { keywords, type, pageNo, loading: false, songs: [], artists: [], total: 0 });
  }

  const allSongs = VUE_APP.$store.getters.getAllSongs;
  dispatch('updateSearch', { keywords, type, pageNo, loading: true });
  const res = await request({
    api: '163_SEARCH',
    data: {
      keywords,
      offset: (pageNo - 1)   * 30,
      type,
    },
    cache: true,
  });
  const obj = {};
  const search = VUE_APP.$store.getters.getSearch;
  res.result.songs = (res.result.songs || []).map((s) => {
    if (!allSongs[s.id]) {
      obj[s.id] = {
        id: s.id,
        name: s.name,
        ar: s.artists.map((a) => a.name).join('/'),
      };
    }
    return s.id;
  });

  if (pageNo > 1) {
    res.result.songs = [ ...search.songs, ...res.result.songs ];
    res.result.artists = [ ...search.artists, ...res.result.artists ];
  }
  if (search.keywords === keywords) {
    dispatch('updateSearch', { ...res.result, loading: false, total: res.result.songCount || res.result.artistCount });
  }
  dispatch('updateAllSongs', obj);

  // 如果是搜索歌曲的，且存在没有加入过 allSongs 的歌曲
  const ids =res.result.songs.join(',');
  if (!ids) {
    return;
  }

  // 获取歌曲的详细信息，搜索到的数据格式和这个接口里的一些字段不一样，而且没有专辑封面这种东西
  request({
    api: 'SONG_DETAIL',
    data: { ids },
    cache: true,
  }).then(({ songs }) => handleSongs(songs));
};

// 处理获取到的歌曲，把他们存到 allSongs 并获取链接
export const handleSongs = (songs) => {
  const VUE_APP = window.VUE_APP;
  const obj = {};
  const allSongs = VUE_APP.$store.getters.getAllSongs;
  const ids = [];
  songs.forEach((s) => {
    obj[s.id] = {
      ...(allSongs[s.id] || {}),
      al: (s.al || s.album),
      ar: (s.ar || s.artists).map((a) => a.name).join('/'),
      arId: (s.ar || s.artists).map((a) => a.id).join('/'),
      name: s.name,
      id: s.id,
    };
    allSongs[s.id] = obj[s.id];
    ids.push(s.id);
  });
  VUE_APP.$store.dispatch('updateAllSongs', obj);
  querySongUrl(ids.join(','));
};

// 喜欢音乐
export const likeMusic = (id) => {
  window.event.stopPropagation();
  const VUE_APP = window.VUE_APP;
  const message = VUE_APP.$message;
  const store= VUE_APP.$store;
  const allList = store.getters.getAllList;
  const userList = store.getters.getUserList;
  const like = allList[userList.favId].indexOf(id) === -1;
  request({
    api: 'LIKE_MUSIC',
    data: { id, like },
  }).then((res) => {
    if (res && res.code === 200) {
      const songs = allList[userList.favId];
      if (like) {
        message.success('爱上！');
        songs.unshift(id);
        store.dispatch('query163List', { songs, listId: userList.favId });
      } else {
        message.success('爱过～');
        store.dispatch('query163List', { songs: songs.filter((s) => s !== id), listId: userList.favId });
      }
      getMyList(Storage.get('uid'), true);

    } else {
      console.log(res);
      message.error('喜欢失败，可能是被下架了')
    }
  })
};

// jsonp 查询qq音乐
const searchQQ = (val, id) => {
  const url = '//c.y.qq.com/soso/fcgi-bin/client_search_cp';
  const { murl, guid, vkey } = Storage.get(['murl', 'guid', 'vkey']);

  if (idMap[id]) {
    setTimeout(() => {
      window.VUE_APP.$store.dispatch('updateSongDetail', { id, qqId: idMap[id], br: 128000, url: `${murl}M500${idMap[id]}.mp3?guid=${guid}&vkey=${vkey}&fromtag=8&uin=0` });
    });
  }
  window.QUERY_QQ_TIMES += 1;
  const data = { p: 1, n: 1, w: val, cr: 1, aggr: 1, jsonpCallback: `SEARCH_QQ_MUSIC_${window.QUERY_QQ_TIMES}`};
  const query = Object.keys(data).map((k) => `${k}=${data[k]}`).join('&');
  const req = `${url}?${query}`;


  window[`SEARCH_QQ_MUSIC_${window.QUERY_QQ_TIMES}`] = (res) => {
    const song = res.data.song.list[0] || {};
    if (song.media_mid && song.size128) {
      window.VUE_APP.$store.dispatch('updateSongDetail', { id, qqId: song.media_mid, br: 128000, url: `${murl}M500${song.media_mid}.mp3?guid=${guid}&vkey=${vkey}&fromtag=8&uin=0` });
    }
  };
  JSONP(req);
};

export const getQQVkey = () => {
  window.getQQMusicUrl = (res) => {
    const mUrl = res.req_0.data.testfile2g;
    const { guid, vkey } = getQueryFromUrl(null, mUrl);
    Storage.set({
      guid,
      vkey,
      vkey_expire: timer().from(90, 'm').str('YYYYMMDDHHmm'),
      // 返回的url信息在播放非128k的音乐时都可能出现403，下面这个链接是从别人的qq音乐项目里找来的
      // murl: res.req_0.data.sip[1] || res.req_0.data.sip[0],
      murl: 'http://183.131.60.16/amobile.music.tc.qq.com/',
    });
  };
  JSONP(apiList['GET_QQ_VKEY']);
};

const JSONP = (url) => {
  const jsonp = document.createElement("script");
  jsonp.type = "text/javascript";
  jsonp.src = url;
  document.getElementsByTagName("head")[0].appendChild(jsonp);
  setTimeout(() => {
    document.getElementsByTagName("head")[0].removeChild(jsonp)
  },500)
};

export default request;