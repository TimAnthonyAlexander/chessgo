#pragma once
// `./zugzwang ratingtest ...` — the calibration harness for the rating ladder
// (rating.cpp + weakening.cpp). See ratingtest.cpp for what each mode measures
// and why. Not part of UCI or the HTTP serve API.
int ratingtest_main(int argc, char** argv);
