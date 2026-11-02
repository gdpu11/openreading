package server

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	"modernc.org/sqlite"
)

func TestWriteTransactionReservesWriterBeforeReading(t *testing.T) {
	c := newClient(t, Config{})
	ctx := context.Background()
	background, err := c.s.db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer background.Close()
	if _, err = background.ExecContext(ctx, "PRAGMA busy_timeout=0"); err != nil {
		t.Fatal(err)
	}
	defer background.ExecContext(ctx, "PRAGMA busy_timeout=5000")
	err = c.s.transaction(func(tx *sql.Tx) error {
		if _, err := one(tx, "SELECT count(*) AS n FROM preferences"); err != nil {
			return err
		}
		// A background autocommit must not invalidate the read snapshot of an
		// active write transaction. No wait is needed to reproduce that race.
		_, err := background.ExecContext(ctx, "INSERT INTO preferences VALUES('background','{}')")
		if err != nil {
			var busy *sqlite.Error
			if !errors.As(err, &busy) || busy.Code()&255 != 5 {
				return err
			}
		}
		return exec(tx, "INSERT INTO preferences VALUES('personal','{\"fontSize\":24}')")
	})
	if err != nil {
		t.Fatalf("write transaction lost its snapshot: %v", err)
	}
	prefs := c.ok("GET", "/api/preferences", nil)
	if num(prefs, "fontSize") != 24 {
		t.Fatal(prefs)
	}
}
