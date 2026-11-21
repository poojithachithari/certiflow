# Sample spreadsheets

Upload these as **Anika** on a draft batch. Regenerate them with `node samples/generate.cjs`.

Required columns (any order, any capitalisation): `enrolment_no, name, phone, date_of_birth, score`.

## Accepted
| File | What it shows |
|---|---|
| `good-60-candidates.csv` | 60 candidates. More than 50, so after district approval it also goes to the **quality team** (Neha) |
| `good-12-candidates.csv` | Small batch: district → state office directly |
| `good-15-candidates.xlsx` | **Excel** upload works the same as CSV |
| `good-indian-formats.csv` | Real-world messiness that is still valid: header `Enrolment No`, phones like `+91 98221 40001` / `098221 40002` / `(982) 214-0004`, dates `15/09/2003` and `02-11-2004`, lowercase enrolment no., score exactly 40 (pass mark) and 100 |

## Rejected (nothing is saved, every problem listed)
| File | Expected errors |
|---|---|
| `bad-mixed-errors.csv` | 5 errors: bad phone (row 3), formula in name (row 4), 31 February (row 5), score 32 below pass mark (row 6), duplicate enrolment no. (row 7). Rows 2 and 8 are valid but are **not** saved either |
| `bad-missing-columns.csv` | `date_of_birth` and `score` columns missing |
| `bad-duplicate-enrolment.csv` | Rows 5 and 7 repeat the enrolment numbers of rows 2 and 3 |
| `bad-failed-candidates.csv` | Scores 39 and 12: below the pass mark of 40 |
| `bad-phone-numbers.csv` | Too short, starts with 5, 11 digits |
| `bad-dates-and-ages.csv` | 30 February, month 13, the word "yesterday", and a 7-year-old |
| `bad-names.csv` | `=HYPERLINK(...)` formula injection, a blank name, digits in a name |
| `bad-errors.xlsx` | Excel file with a bad phone and a failing score |
| `bad-empty.csv` | Header only, no candidates |
| `bad-too-many-rows.csv` | 1001 rows (limit is 1000 per batch) |
| `bad-wrong-file-type.txt` | Not a .csv or .xlsx |

Also rejected, without a special file: uploading a list where someone is **already certified for the same course** (e.g. upload `good-12-candidates.csv` again to a new batch of the same course after the first one was issued).

All good files use different enrolment numbers, so you can use them all in one demo.
