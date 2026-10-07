{
  description = "remembrancer: per-project working memory (todos, questions, answers, rules) for you and your agent";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      supportedSystems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs supportedSystems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: {
        default = pkgs.stdenvNoCC.mkDerivation {
          pname = "remembrancer";
          version = "0.1.0";
          src = ./.;
          nativeBuildInputs = [ pkgs.makeWrapper ];
          # No npm dependencies: run the sources directly with bun.
          installPhase = ''
            mkdir -p $out/share/remembrancer $out/bin
            cp -r src skill schema package.json $out/share/remembrancer/
            makeWrapper ${pkgs.bun}/bin/bun $out/bin/remembrancer \
              --add-flags $out/share/remembrancer/src/cli.ts
            ln -s remembrancer $out/bin/rmb
          '';
          meta.mainProgram = "remembrancer";
        };
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell { packages = [ pkgs.bun ]; };
      });
    };
}
