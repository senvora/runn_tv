import os
import gzip
import requests
from lxml import etree
from datetime import datetime, timedelta, timezone

# GitHub Secret
JSON_URL = os.environ["RUNNTV_JSON_URL"]


def xmltv_date(timestamp_ms):
    dt = datetime.fromtimestamp(timestamp_ms / 1000, timezone.utc)
    ist = dt.astimezone(timezone(timedelta(hours=5, minutes=30)))
    return ist.strftime("%Y%m%d%H%M%S +0530")


def fetch_all():
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

        return []

    except Exception as e:
        print("Fetch failed:", e)
        return []


def build_xml(channels):
    root = etree.Element(
        "tv",
        date=xmltv_date(int(datetime.now().timestamp() * 1000)),
        **{
            "generator-info-name": "RunnTV EPG Generator",
            "generator-info-url": "https://github.com/senvora"
        }
    )

    merged_channels = {}
    programme_set = set()

    # Merge duplicate channels using numeric ID
    for channel in channels:
        channel_id = str(channel.get("id", "")).strip()

        if not channel_id:
            continue

        schedules = channel.get("schedules") or []

        if channel_id not in merged_channels:
            merged_channels[channel_id] = dict(channel)
            merged_channels[channel_id]["schedules"] = list(schedules)
        else:
            merged_channels[channel_id]["schedules"].extend(schedules)

    # Channels
    for channel_id, channel in merged_channels.items():
        channel_el = etree.SubElement(root, "channel", id=channel_id)

        display_name = etree.SubElement(channel_el, "display-name")
        display_name.text = (
            channel.get("channelName")
            or channel.get("title")
            or f"Channel {channel_id}"
        )

        images = channel.get("images") or {}
        logo_data = images.get("logo") or {}

        logo = (
            logo_data.get("web")
            or logo_data.get("mobile")
            or logo_data.get("tv")
        )

        if logo:
            logo_url = channel.get("baseSourceLocation", "") + logo
            etree.SubElement(channel_el, "icon", src=logo_url)

    # Programmes
    for channel_id, channel in merged_channels.items():
        schedules = channel.get("schedules") or []

        for epg in schedules:
            if not isinstance(epg, dict):
                continue

            start = epg.get("startTimeEpoch") or epg.get("startTime")
            if not start:
                continue

            duration = epg.get("durationSeconds", 0)
            stop = start + duration * 1000

            key = f"{channel_id}_{start}_{epg.get('programName')}"

            if key in programme_set:
                continue

            programme_set.add(key)

            prog = etree.SubElement(
                root,
                "programme",
                start=xmltv_date(start),
                stop=xmltv_date(stop),
                channel=channel_id
            )

            title = etree.SubElement(prog, "title", lang="en")
            title.text = epg.get("programName", "Unknown")

            desc = etree.SubElement(prog, "desc", lang="en")
            desc.text = (
                epg.get("description")
                or epg.get("programName")
                or ""
            )

            genres = epg.get("genres") or []

            if not isinstance(genres, list):
                genres = []

            for genre in genres:
                if not isinstance(genre, dict):
                    continue

                name = genre.get("name")
                if name:
                    cat = etree.SubElement(prog, "category")
                    cat.text = name

    return root


def main():
    channels = fetch_all()

    if not channels:
        print("No channels fetched")
        return

    print("Total channels:", len(channels))

    xml_root = build_xml(channels)

    # Create output directory
    os.makedirs("epg", exist_ok=True)

    xml_bytes = etree.tostring(
        xml_root,
        pretty_print=True,
        xml_declaration=True,
        encoding="UTF-8"
    )

    output_path = "epg/runntv.xml.gz"

    with gzip.open(output_path, "wb") as f:
        f.write(xml_bytes)

    print(f"Generated {output_path} successfully")


if __name__ == "__main__":
    main()