import os
import requests

JSON_URL = os.environ["RUNNTV_JSON_URL"]

EPG_URL = "https://raw.githubusercontent.com/senvora/runn_tv/main/epg/runntv.xml.gz"

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/149.0.0.0 Safari/537.36"
)
ORIGIN = "https://runn.tv"
REFERER = "https://runn.tv/"


GROUP_MAP = {
    "News": [
        "abp_news", "abpana", "abpasm", "abpmaj",
        "apkadt", "gtcnew", "india_tv_news", "mahkhb", "newnat",
        "nnatuk", "nnbrjh", "nnmpcg", "nnpbhr",
        "prd_navbht", "spdnws", "tv9bha", "tv9mar",
        "tv9mar", "tv9news9", "tv9tel"
    ],

    "Entertainment": [
        "alrght", "dicmed", "filcop", "gtcpun",
        "jusgag", "mahply", "mangot", "mrbean",
        "p_cinshf", "p_tttflm", "pitcom", "swasto"
    ],

    "Movies": [
        "b4ubho", "b4ukad", "b4umov", "blyflx",
        "blygld", "blywcm", "ersent", "p_runact",
        "p_runthr", "p_supflm", "p_supjio",
        "pitara", "shemaroo-bollywood", "suptam"
    ],

    "Short Films": [
        "p_pktflm", "p_runshf", "punsho"
    ],

    "Sports": [
        "amuspo", "criusa", "dridri", "figfig",
        "goagoa", "hoohoo", "mmaatv", "xtrspo"
    ],

    "Music": [
        "9xjalw", "b4umus", "blyrag", "run9xm",
        "saghar", "sagmus", "shemaroo-filmigaane", "yrfmus"
    ],

    "Lifestyle": [
        "indtvy", "jagran", "outcha"
    ],

    "Kids": [
        "carcar", "gregld", "lookid", "p_nunutv"
    ],

    "Devotional": [
        "divbha", "divdiv", "sikrat"
    ]
}

# NEW: preserve group order from GROUP_MAP
GROUP_ORDER = {
    group: index
    for index, group in enumerate(GROUP_MAP.keys())
}
GROUP_ORDER["Undefined"] = len(GROUP_MAP)


def fetch_channels():
    try:
        print("Fetching merged JSON...")
        response = requests.get(JSON_URL, timeout=60)
        print("Status:", response.status_code)

        if response.status_code != 200:
            return []

        data = response.json()

        if isinstance(data, list):
            print(f"Fetched {len(data)} channels")
            return data

        print("Invalid JSON format")
        return []

    except Exception as e:
        print("Fetch failed:", e)
        return []


def clean(text=""):
    return (
        str(text)
        .strip()
        .replace('"', "'")
        .replace("\n", " ")
        .replace("\r", "")
    )


def get_channel_name(channel):
    return clean(
        channel.get("channelName")
        or (channel.get("schedules", [{}])[0].get("channelName"))
        or channel.get("title")
        or channel.get("channelCode")
        or ""
    )


def get_group_title(channel):
    code = str(channel.get("channelCode", "")).strip().lower()

    for group, codes in GROUP_MAP.items():
        if code in codes:
            return group

    return "Undefined"


def generate_m3u(channels):
    m3u = f'#EXTM3U url-tvg="{EPG_URL}"\n\n'

    # NEW: Sort by group order, then alphabetically by channel name
    channels = sorted(
        channels,
        key=lambda channel: (
            GROUP_ORDER.get(get_group_title(channel), 999),
            get_channel_name(channel).lower()
        )
    )

    seen = set()
    written = 0

    for channel in channels:
        channel_id = str(channel.get("id", "")).strip()

        if not channel_id:
            continue

        if channel_id in seen:
            continue
        seen.add(channel_id)

        name = get_channel_name(channel)

        channel_code = clean(
            channel.get("channelCode")
            or name
        )

        play_url = str(channel.get("playUrl", "")).strip()

        if not play_url.startswith("http"):
            continue

        group_title = get_group_title(channel)

        logo = (
            channel.get("images", {})
            .get("logo", {})
            .get("web")
            or channel.get("images", {})
            .get("logo", {})
            .get("mobile")
            or channel.get("images", {})
            .get("logo", {})
            .get("tv")
            or ""
        )

        logo_url = ""
        if logo:
            logo_url = clean(channel.get("baseSourceLocation", "") + logo)

        m3u += (
            f'#EXTINF:-1 '
            f'tvg-id="{channel_id}" '
            f'tvg-name="{channel_code}" '
            f'tvg-logo="{logo_url}" '
            f'group-title="{group_title}" '
            f'tvg-chno="{channel_id}",'
            f'{name}\n'
        )

        m3u += f"#EXTVLCOPT:http-user-agent={USER_AGENT}\n"
        m3u += f"#EXTVLCOPT:http-origin={ORIGIN}\n"
        m3u += f"#EXTVLCOPT:http-referer={REFERER}\n"

        m3u += f"{play_url}\n\n"

        written += 1

    print(f"Channels written: {written}")
    return m3u


def main():
    channels = fetch_channels()

    if not channels:
        print("No channels found")
        return

    m3u = generate_m3u(channels)

    os.makedirs("playlist", exist_ok=True)

    output_path = "playlist/runntv.m3u"

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(m3u)

    print(f"Generated {output_path} successfully")


if __name__ == "__main__":
    main()