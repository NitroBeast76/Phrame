// Custom digit font for the time gun's cylinder, drawn to match the reference frame: wide, squared-off
// glyphs with rounded corners, flat tops and bottoms, a diagonal-stem 4 and a flagged 1.
// Each glyph is a centre-line path in a 14.5 x 13 box (y down). Draw it twice, a wide dark stroke
// first and a thinner khaki stroke on top (see .tg-glyph-* in TimeGun.css), so it reads as outlined lettering.

export const DIGIT_BOX = { w: 14.5, h: 13 };

export const DIGIT_PATHS: Record<string, string> = {
	"0": "M2.6 0H11.9Q14.5 0 14.5 2.6V10.4Q14.5 13 11.9 13H2.6Q0 13 0 10.4V2.6Q0 0 2.6 0Z",
	"1": "M4.8 2.8L8.5 0V13",
	"2": "M0 2.6Q0 0 2.6 0H11.9Q14.5 0 14.5 2.6V3.9Q14.5 6.5 11.9 6.5H2.6Q0 6.5 0 9.4V13H14.5",
	"3": "M0 0H11.9Q14.5 0 14.5 2.6V3.9Q14.5 6.5 11.9 6.5H5M11.9 6.5Q14.5 6.5 14.5 9.1V10.4Q14.5 13 11.9 13H0",
	"4": "M10 0L0.8 8.3H14.5M10 0V13",
	"5": "M14.5 0H1V6.2H11.9Q14.5 6.2 14.5 8.8V10.4Q14.5 13 11.9 13H0",
	"6": "M14.5 0H2.6Q0 0 0 2.6V10.4Q0 13 2.6 13H11.9Q14.5 13 14.5 10.4V9.1Q14.5 6.5 11.9 6.5H0",
	"7": "M0 0H14.5L5.8 13",
	"8": "M2.6 0H11.9Q14.5 0 14.5 2.6V3.9Q14.5 6.5 11.9 6.5H2.6Q0 6.5 0 3.9V2.6Q0 0 2.6 0ZM2.6 6.5H11.9Q14.5 6.5 14.5 9.1V10.4Q14.5 13 11.9 13H2.6Q0 13 0 10.4V9.1Q0 6.5 2.6 6.5Z",
	"9": "M0 13H11.9Q14.5 13 14.5 10.4V2.6Q14.5 0 11.9 0H2.6Q0 0 0 2.6V3.9Q0 6.5 2.6 6.5H14.5"
};

/** Thin detail strokes some glyphs carry on top (the reference zero has two small diagonal ticks inside it). */
export const DIGIT_TICKS: Record<string, string> = {
	"0": "M11.7 2.2L8.9 5M2.8 10.8L5.6 8"
};
