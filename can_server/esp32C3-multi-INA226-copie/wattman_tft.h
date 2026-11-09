#pragma once
#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>
#include <Preferences.h>

// ST7735S 1.44 inch 128x128, on the SAME SPI bus as the MCP2515.
// GPIO numbers, not connector positions. Never use GPIO18/19 (native USB).
constexpr uint8_t TFT_CS = 0, TFT_DC = 1, TFT_RESET = 3;
constexpr uint16_t TFT_BACKGROUND = 0x0843, TFT_CARD = 0x18C6;
constexpr uint8_t TFT_ROTATION = 0;
Adafruit_ST7735 messageTft(&SPI, TFT_CS, TFT_DC, TFT_RESET);
enum TftStage : uint8_t { TFT_BOOT, TFT_PROJECT, TFT_METHOD, TFT_DIGITAL_SELECTED,
                         TFT_CAN_SELECTED, TFT_DIGITAL_READY, TFT_CAN_READY, TFT_ACQUISITION };
TftStage tftStage = TFT_BOOT;
SemaphoreHandle_t displayStateMutex = nullptr;
char displayPilot[257] = {}, displayProject[257] = {};
Preferences displayPreferences;

// Convert French UTF-8 text to CP437, the built-in pixel font's encoding.
// ASCII fallback for unsupported characters; no broken UTF-8 glyph fragments.
String tftText(const String& input) {
  String output;
  for (unsigned int i = 0; i < input.length();) {
    uint8_t c = input[i++];
    if (c < 128) { output += char(c); continue; }
    uint32_t code = 0;
    uint8_t count = 0;
    if ((c & 0xE0) == 0xC0) { code = c & 0x1F; count = 1; }
    else if ((c & 0xF0) == 0xE0) { code = c & 0x0F; count = 2; }
    else if ((c & 0xF8) == 0xF0) { code = c & 7; count = 3; }
    for (uint8_t k = 0; k < count && i < input.length(); ++k) code = (code << 6) | (input[i++] & 0x3F);
    switch (code) {
      case 0xE9: output += char(130); break; // é
      case 0xE8: output += char(138); break; // è
      case 0xEA: output += char(136); break; // ê
      case 0xEB: output += char(137); break;
      case 0xE0: output += char(133); break; // à
      case 0xE2: output += char(131); break;
      case 0xE7: output += char(135); break;
      case 0xF4: output += char(147); break;
      case 0xF6: output += char(148); break;
      case 0xF9: output += char(151); break;
      case 0xFB: output += char(150); break;
      case 0xEE: output += char(140); break;
      case 0xEF: output += char(139); break;
      case 0xC9: output += char(144); break;
      case 0xC7: output += char(128); break;
      case 0x153: output += "oe"; break;
      case 0x152: output += "OE"; break;
      case 0xC0: case 0xC2: output += 'A'; break;
      case 0xC8: case 0xCA: case 0xCB: output += 'E'; break;
      case 0x2019: output += '\''; break;
      default: output += '?'; break;
    }
  }
  return output;
}

void tftHeading(GFXcanvas16& frame, const char* label, uint16_t color) {
  frame.fillScreen(TFT_BACKGROUND);
  frame.setTextWrap(false);
  frame.setTextSize(1);
  frame.setTextColor(color);
  frame.setCursor(7, 7);
  frame.print(label);
  frame.drawFastHLine(6, 22, 116, color);
}

// 19 characters, 8 lines per page, 6 px side margins, and a dedicated footer.
// Names are wrapped and paginated too, never silently cut off at the edge.
void tftParagraph(GFXcanvas16& frame, const String& raw, uint32_t elapsed) {
  const String text = tftText(raw);
  String lines[48];
  uint8_t count = 1;
  for (unsigned int i = 0; i < text.length() && count < 48;) {
    if (text[i] == '\f') { count = ((count + 7) / 8) * 8 + 1; ++i; continue; }
    if (text[i] == '\n') { ++count; ++i; continue; }
    if (text[i] == ' ') { ++i; continue; }
    unsigned int end = i;
    while (end < text.length() && text[end] != ' ' && text[end] != '\n' && text[end] != '\f') ++end;
    String word = text.substring(i, end);
    while (word.length()) {
      if (lines[count - 1].length() && lines[count - 1].length() + 1 + word.length() > 19) ++count;
      if (count >= 48) break;
      if (lines[count - 1].length()) lines[count - 1] += ' ';
      const unsigned int space = 19 - lines[count - 1].length();
      lines[count - 1] += word.substring(0, space);
      word.remove(0, space);
      if (word.length()) ++count;
    }
    i = end;
  }
  const uint8_t pages = (count + 7) / 8;
  const uint8_t page = (elapsed / 6000UL) % pages;
  frame.setTextColor(ST77XX_WHITE);
  for (uint8_t row = 0; row < 8; ++row) {
    const uint8_t index = page * 8 + row;
    if (index >= count) break;
    frame.setCursor(7, 29 + row * 10);
    frame.print(lines[index]);
  }
  if (pages > 1) {
    frame.setTextColor(ST77XX_CYAN);
    frame.setCursor(99, 117);
    frame.printf("%u/%u", page + 1, pages);
  }
}

void tftChannel(GFXcanvas16& frame, char channel, uint8_t y, uint8_t height,
                uint32_t frequency, uint32_t duration, bool running, bool finished) {
  const uint32_t elapsed = (millis() - testStartMillis) / 1000UL;
  const uint32_t remaining = elapsed < duration ? duration - elapsed : 0;
  const uint16_t color = running ? ST77XX_CYAN : finished ? ST77XX_GREEN : ST77XX_ORANGE;
  frame.fillRoundRect(5, y, 118, height, 5, TFT_CARD);
  frame.setTextSize(1);
  frame.setTextColor(color);
  frame.setCursor(10, y + 6);
  frame.printf("Canal %c - %lu Hz", channel, (unsigned long)frequency);
  frame.setTextColor(ST77XX_WHITE);
  frame.setCursor(10, y + 19);
  if (running) frame.printf("%luj %02lu:%02lu:%02lu", (unsigned long)(remaining / 86400),
      (unsigned long)((remaining / 3600) % 24), (unsigned long)((remaining / 60) % 60), (unsigned long)(remaining % 60));
  else frame.print(tftText(finished ? "Canal terminé" : "Canal arrêté"));
  const uint8_t barY = y + height - 10;
  frame.drawRoundRect(10, barY, 108, 6, 2, color);
  const uint32_t progress = finished ? 106 : duration ? min((uint64_t)elapsed * 106 / duration, 106ULL) : 0;
  if (progress) frame.fillRect(11, barY + 1, progress, 4, color);
}

void initializeMessageTft() {
  // Full controller init and hardware RESET on EVERY ESP32 power-up.
  xSemaphoreTake(canMutex, portMAX_DELAY);
  messageTft.initR(INITR_144GREENTAB);
  messageTft.setSPISpeed(8000000);
  messageTft.setRotation(TFT_ROTATION);
  messageTft.enableSleep(false);
  messageTft.enableDisplay(true);
  messageTft.fillScreen(TFT_BACKGROUND);
  xSemaphoreGive(canMutex);
}

void taskTft(void*) {
  GFXcanvas16 frame(128, 128);
  if (!frame.getBuffer()) { Serial.println("[TFT] Frame allocation failed."); vTaskDelete(nullptr); return; }
  frame.cp437(true);
  uint32_t previousHash[128] = {};
  bool drawn[128] = {};
  TftStage lastStage = TFT_BOOT;
  uint32_t stageStarted = millis(), lastKeepAwake = 0;
  for (;;) {
    char pilot[257], project[257];
    xSemaphoreTake(displayStateMutex, portMAX_DELAY);
    const TftStage stage = tftStage;
    strlcpy(pilot, displayPilot, sizeof(pilot));
    strlcpy(project, displayProject, sizeof(project));
    xSemaphoreGive(displayStateMutex);
    if (stage != lastStage) { lastStage = stage; stageStarted = millis(); }
    if (stage == TFT_ACQUISITION) {
      tftHeading(frame, testRunning ? "MESURE EN COURS" : "MESURE TERMINEE", testRunning ? ST77XX_CYAN : ST77XX_GREEN);
      const bool both = currentCfg.activeA && currentCfg.activeB;
      const uint8_t height = both ? 43 : 64;
      uint8_t y = both ? 29 : 42;
      if (currentCfg.activeA) {
        tftChannel(frame, 'A', y, height, targetFrequencyA, testDurationSecA, sensorRunningA, sensorFinishedA && !sensorStoppedA);
        y += 49;
      }
      if (currentCfg.activeB) tftChannel(frame, 'B', y, height, targetFrequencyB, testDurationSecB, sensorRunningB, sensorFinishedB && !sensorStoppedB);
    } else {
      tftHeading(frame, "WATTMAN", ST77XX_CYAN);
      String text;
      switch (stage) {
        case TFT_PROJECT:
          text = String("Bonjour ") + (pilot[0] ? pilot : "Wattman") + ",\nbienvenue sur le projet\n" + (project[0] ? project : "Non renseigné"); break;
        case TFT_METHOD: text = "Choisissez une méthode de mesure."; break;
        case TFT_DIGITAL_SELECTED: text = "Vous avez choisi mesure numérique."; break;
        case TFT_CAN_SELECTED: text = "Vous avez choisi mesure CAN."; break;
        case TFT_DIGITAL_READY:
        case TFT_CAN_READY:
          text = "Veuillez vous connecter au Wi-Fi esp32_mesure avant de démarrer une mesure.";
          if (stage == TFT_CAN_READY) text += "\fVeuillez activer l'enregistrement sur CANalyzer avant de démarrer une mesure.";
          break;
        default: text = "Écran prêt.\nOuvrez votre projet Wattman."; break;
      }
      tftParagraph(frame, text, millis() - stageStarted);
    }
    // One row per transaction (~0.26 ms at 8 MHz), then release CAN's mutex.
    for (uint8_t stripe = 0; stripe < 128; ++stripe) {
      uint16_t* pixels = frame.getBuffer() + stripe * 128;
      uint32_t hash = 2166136261UL;
      for (uint16_t i = 0; i < 128; ++i) hash = (hash ^ pixels[i]) * 16777619UL;
      if (drawn[stripe] && hash == previousHash[stripe]) continue;
      if (xSemaphoreTake(canMutex, pdMS_TO_TICKS(2)) != pdTRUE) continue;
      messageTft.drawRGBBitmap(0, stripe, pixels, 128, 1);
      xSemaphoreGive(canMutex);
      drawn[stripe] = true;
      previousHash[stripe] = hash;
      vTaskDelay(1);
    }
    if (millis() - lastKeepAwake >= 1000 && xSemaphoreTake(canMutex, pdMS_TO_TICKS(2)) == pdTRUE) {
      messageTft.enableDisplay(true);
      xSemaphoreGive(canMutex);
      lastKeepAwake = millis();
    }
    vTaskDelay(pdMS_TO_TICKS(250));
  }
}
