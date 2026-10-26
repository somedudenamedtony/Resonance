#include "rc_update.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"

// Next dotted number at *p, or -1 when the numbers have run out.
static long next_part(const char **p)
{
    if (!isdigit((unsigned char)**p)) return -1;
    char *end;
    long v = strtol(*p, &end, 10);
    *p = *end == '.' ? end + 1 : end;
    return v;
}

int rc_version_compare(const char *a, const char *b)
{
    if (*a == 'v' || *a == 'V') a++;
    if (*b == 'v' || *b == 'V') b++;
    for (;;) {
        long x = next_part(&a), y = next_part(&b);
        if (x < 0 && y < 0) break;
        if (x < 0) x = 0;  // "1.2" == "1.2.0"
        if (y < 0) y = 0;
        if (x != y) return x < y ? -1 : 1;
    }
    // Same numbers: a suffix ("-beta") means a pre-release, which comes first.
    bool pa = *a == '-', pb = *b == '-';
    if (pa != pb) return pa ? -1 : 1;
    return pa ? strcmp(a, b) : 0;
}

static bool find_asset(const cJSON *assets, const char *name, rc_asset_t *out)
{
    const cJSON *a;
    cJSON_ArrayForEach(a, assets)
    {
        const cJSON *n = cJSON_GetObjectItemCaseSensitive(a, "name");
        const cJSON *url = cJSON_GetObjectItemCaseSensitive(a, "browser_download_url");
        const cJSON *size = cJSON_GetObjectItemCaseSensitive(a, "size");
        if (!cJSON_IsString(n) || strcmp(n->valuestring, name) != 0) continue;
        if (!cJSON_IsString(url) || strncmp(url->valuestring, "https://", 8) != 0 ||
            strlen(url->valuestring) >= sizeof out->url || !cJSON_IsNumber(size) || size->valuedouble < 1 ||
            size->valuedouble > 16 * 1024 * 1024)
            return false;
        snprintf(out->url, sizeof out->url, "%s", url->valuestring);
        out->size = (uint32_t)size->valuedouble;
        return true;
    }
    return false;
}

bool rc_release_parse(const char *json, size_t len, rc_release_t *out, char *err, size_t err_cap)
{
    memset(out, 0, sizeof *out);
    cJSON *o = cJSON_ParseWithLength(json, len);
    if (!o) {
        snprintf(err, err_cap, "GitHub's answer wasn't readable.");
        return false;
    }
    bool ok = false;
    const cJSON *tag = cJSON_GetObjectItemCaseSensitive(o, "tag_name");
    const cJSON *assets = cJSON_GetObjectItemCaseSensitive(o, "assets");
    if (!cJSON_IsString(tag) || !tag->valuestring[0]) {
        snprintf(err, err_cap, "There's no release on GitHub yet.");
    } else {
        const char *v = tag->valuestring;
        if (*v == 'v' || *v == 'V') v++;
        snprintf(out->version, sizeof out->version, "%s", v);
        if (!find_asset(assets, RC_ASSET_FIRMWARE, &out->firmware) || !find_asset(assets, RC_ASSET_APP, &out->app))
            snprintf(err, err_cap, "Release %s is missing " RC_ASSET_FIRMWARE " or " RC_ASSET_APP ".", tag->valuestring);
        else ok = true;
    }
    cJSON_Delete(o);
    return ok;
}

bool rc_image_magic_ok(const char *target, const uint8_t *d, size_t n)
{
    if (strcmp(target, "firmware") == 0) return n >= 1 && d[0] == 0xE9;  // ESP image header
    return n >= 16 && memcmp(d + 8, "littlefs", 8) == 0;                 // LittleFS superblock
}
