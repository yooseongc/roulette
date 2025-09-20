

function utf8_to_b64(str: string): string {
  return window.btoa(unescape(encodeURIComponent( str )));
}

function b64_to_utf8(str: string): string {
  return decodeURIComponent(escape(window.atob( str )));
}

function getBlacklist(): string[] {
  const data = localStorage.getItem('marble_blacklist');
  const default_value = 'WyLshJzsmIjsp4QiLCLquYDri6TtnawiLCLquYDso7zrpqwiLCLsi6DsmIHssqAiLCLsnbTsnYDshK0iLCLsnbTssKztnawiLCLsnbTtmJXshJ0iLCLstZzsnKDshLEiLCLtmansiJjrr7wiXQ==';
  console.log(b64_to_utf8(default_value));
  if(!data) {
    localStorage.setItem('marble_blacklist', b64_to_utf8(default_value));
  }
  return data ? JSON.parse(data) : JSON.parse(b64_to_utf8(default_value));
}

function setBlacklist(list: string[]) {
  localStorage.setItem('marble_blacklist', JSON.stringify(list));
}

function getCustomScale(): number {
  const data = localStorage.getItem('marble_customScale');
  if(!data) {
    localStorage.setItem('marble_customScale', String(0.3));
  }
  return data ? Number(data) : 0.3;
}

function setCustomScale(scale: number) {
  localStorage.setItem('marble_customScale', String(scale));
}

function useFixedScale(): boolean {
  const data = localStorage.getItem('marble_useFixedScale');
    if(!data) {
        localStorage.setItem('marble_useFixedScale', 'false');
    }
    return data === 'true' ? true : false;
}

function setUseFixedScale(use: boolean) {
    localStorage.setItem('marble_useFixedScale', use ? 'true' : 'false');
}

const storage = {
    getBlacklist,
    setBlacklist,
    getCustomScale,
    setCustomScale,
    useFixedScale,
    setUseFixedScale,
};

export default storage;
