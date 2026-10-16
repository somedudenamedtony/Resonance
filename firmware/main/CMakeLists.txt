idf_component_register(
    SRCS "main.c" "bridge_task.c" "usb_link.c" "wifi.c" "web.c" "status_led.c"
    INCLUDE_DIRS "."
    REQUIRES resonance_core esp_wifi esp_netif esp_event esp_http_server nvs_flash esp_timer)
# usb_host_cdc_acm, led_strip and littlefs come from idf_component.yml and are added automatically.
