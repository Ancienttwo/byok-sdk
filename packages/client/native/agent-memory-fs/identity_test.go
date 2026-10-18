package main

import "testing"

func TestTaggedIdentityRejectsMixedFieldsAndOverflow(t *testing.T) {
	cases := []struct {
		name     string
		identity rootIdentity
		valid    bool
	}{
		{"unix max", rootIdentity{Kind: "unix", Dev: "18446744073709551615", Ino: "9007199254740993"}, true},
		{"windows max", rootIdentity{Kind: "windows", VolumeSerial: "4294967295", FileIndex: "18446744073709551615"}, true},
		{"zero", rootIdentity{Kind: "windows", VolumeSerial: "0", FileIndex: "0"}, true},
		{"mixed unix", rootIdentity{Kind: "unix", Dev: "1", Ino: "2", FileIndex: "2"}, false},
		{"mixed windows", rootIdentity{Kind: "windows", VolumeSerial: "1", FileIndex: "2", Dev: "1"}, false},
		{"untagged", rootIdentity{Dev: "1", Ino: "2"}, false},
		{"volume overflow", rootIdentity{Kind: "windows", VolumeSerial: "4294967296", FileIndex: "1"}, false},
		{"index overflow", rootIdentity{Kind: "windows", VolumeSerial: "1", FileIndex: "18446744073709551616"}, false},
		{"unix overflow", rootIdentity{Kind: "unix", Dev: "18446744073709551616", Ino: "1"}, false},
		{"leading zero", rootIdentity{Kind: "unix", Dev: "01", Ino: "2"}, false},
		{"negative", rootIdentity{Kind: "unix", Dev: "1", Ino: "-2"}, false},
		{"sign", rootIdentity{Kind: "unix", Dev: "+1", Ino: "2"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := validRootIdentity(tc.identity); got != tc.valid {
				t.Fatalf("validRootIdentity(%#v) = %v, want %v", tc.identity, got, tc.valid)
			}
		})
	}
}
