idf_component_register(
    SRCS "main.c" "bridge_task.c" "usb_link.c" "wifi.c" "web.c" "status_led.c" "ota.c" "release_update.c" "battery.c"
    INCLUDE_DIRS "."
    REQUIRES resonance_core esp_wifi esp_netif esp_event esp_http_server esp_http_client esp-tls mbedtls nvs_flash
             esp_timer app_update esp_partition esp_adc esp_driver_gpio)
# usb_host_cdc_acm, led_strip, littlefs and mdns come from idf_component.yml and are added automatically.
